import type { SearchOptions, SearchResult, Document, ErrorCode } from '../types.js';
import { getDb, findErrorCode, logSearch } from './doc-store.js';
import { tokenizeForSearch } from './tokenizer.js';

// ---------------------------------------------------------------------------
// Source name mapping
// ---------------------------------------------------------------------------

const SOURCE_NAME_MAP: Record<string, string> = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
};

function sourceName(sourceId: string): string {
  return SOURCE_NAME_MAP[sourceId] ?? sourceId;
}

// ---------------------------------------------------------------------------
// Query type detection
// ---------------------------------------------------------------------------

export function detectQueryType(query: string): 'error_code' | 'api_path' | 'keyword' {
  const trimmed = query.trim();

  // 纯数字 或 errcode \d+ 模式 → 错误码
  if (/^\d+$/.test(trimmed) || /^errcode\s*\d+$/i.test(trimmed)) {
    return 'error_code';
  }

  // 以 / 开头，或包含 /cgi-bin/ 或 /open-apis/ → API 路径
  if (trimmed.startsWith('/') || /\/cgi-bin\//.test(trimmed) || /\/open-apis\//.test(trimmed)) {
    return 'api_path';
  }

  return 'keyword';
}

// ---------------------------------------------------------------------------
// Snippet generation
// ---------------------------------------------------------------------------

export function generateSnippet(content: string, query: string, maxLength = 200): string {
  if (!content) return '';

  // 清理 Markdown 标记和多余空白
  const cleaned = content
    .replace(/[#*`\[\]()>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxLength) return cleaned;

  // 尝试找到查询词首次出现的位置
  const lowerContent = cleaned.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();

  let pos = lowerContent.indexOf(lowerQuery);

  // 如果完整查询没找到，尝试用第一个词
  if (pos === -1) {
    const firstWord = lowerQuery.split(/\s+/)[0];
    if (firstWord) {
      pos = lowerContent.indexOf(firstWord);
    }
  }

  if (pos === -1) {
    // 没找到匹配，返回开头
    return cleaned.slice(0, maxLength) + '...';
  }

  // 计算截取范围，让匹配词居中
  const halfLen = Math.floor(maxLength / 2);
  let start = Math.max(0, pos - halfLen);
  let end = Math.min(cleaned.length, start + maxLength);

  // 如果 end 到底了，往前调 start
  if (end === cleaned.length) {
    start = Math.max(0, end - maxLength);
  }

  let snippet = cleaned.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < cleaned.length) snippet = snippet + '...';

  return snippet;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoredRow {
  doc: Document;
  fts_rank?: number;
  score: number;
}

function computeScore(
  doc: Document,
  originalQuery: string,
  tokens: string[],
  ftsRank: number | undefined,
): number {
  let score = 0;

  const titleLower = (doc.title ?? '').toLowerCase();
  const queryLower = originalQuery.toLowerCase().trim();

  // title 完全包含原始查询 → +20
  if (queryLower && titleLower.includes(queryLower)) {
    score += 20;
  }

  // title 中分词 token 匹配比例 × 5
  if (tokens.length > 0) {
    let matched = 0;
    for (const token of tokens) {
      if (titleLower.includes(token.toLowerCase())) {
        matched++;
      }
    }
    score += (matched / tokens.length) * 5;
  }

  // FTS5 bm25 rank × 1（bm25 返回负数，取绝对值）
  if (ftsRank !== undefined) {
    score += Math.abs(ftsRank);
  }

  // doc_type = 'api_reference' → +3
  if (doc.doc_type === 'api_reference') {
    score += 3;
  }

  // 时效性加分
  if (doc.last_updated) {
    const now = new Date().toISOString();
    const diffMs = new Date(now).getTime() - new Date(doc.last_updated).getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays <= 30) {
      score += 3;
    } else if (diffDays <= 90) {
      score += 1;
    }
  }

  // path_depth 减分
  score -= (doc.path_depth ?? 1) * 0.5;

  return score;
}

// ---------------------------------------------------------------------------
// Error code search
// ---------------------------------------------------------------------------

export function searchErrorCode(code: string): {
  errorCode: ErrorCode | null;
  relatedDoc: Document | null;
} {
  const codeStr = code.replace(/^errcode\s*/i, '').trim();
  const ec = findErrorCode(codeStr);

  if (!ec) {
    return { errorCode: null, relatedDoc: null };
  }

  let relatedDoc: Document | null = null;
  if (ec.doc_id) {
    const db = getDb();
    relatedDoc =
      (db.prepare('SELECT * FROM documents WHERE id = ?').get(ec.doc_id) as Document | undefined) ??
      null;
  }

  return { errorCode: ec, relatedDoc };
}

// ---------------------------------------------------------------------------
// Main search
// ---------------------------------------------------------------------------

export function search(
  options: SearchOptions,
): { results: SearchResult[]; totalCount: number; tookMs: number } {
  const startTime = Date.now();
  const db = getDb();
  const { query, source, mode, limit: rawLimit = 5 } = options;
  const limit = Math.min(rawLimit, 20);
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return { results: [], totalCount: 0, tookMs: Date.now() - startTime };
  }

  const queryType = detectQueryType(trimmedQuery);
  let scoredRows: ScoredRow[] = [];

  // ----- 错误码搜索 -----
  if (queryType === 'error_code') {
    const codeStr = trimmedQuery.replace(/^errcode\s*/i, '').trim();
    const ec = findErrorCode(codeStr);

    if (ec) {
      // 如果有关联文档，取出来
      if (ec.doc_id) {
        const doc = db
          .prepare('SELECT * FROM documents WHERE id = ?')
          .get(ec.doc_id) as Document | undefined;
        if (doc) {
          scoredRows.push({ doc, score: 50 });
        }
      }

      // 即使没有关联文档，也把错误码信息作为结果
      if (scoredRows.length === 0) {
        // 搜索包含该错误码的文档
        const docs = db
          .prepare(
            `SELECT * FROM documents WHERE content LIKE ? ${source ? 'AND source_id = ?' : ''} ${mode ? 'AND dev_mode = ?' : ''} LIMIT ?`,
          )
          .all(
            ...[`%${codeStr}%`, ...(source ? [source] : []), ...(mode ? [mode] : []), limit].filter(
              (v) => v !== undefined,
            ),
          ) as Document[];

        for (const doc of docs) {
          scoredRows.push({ doc, score: 50 });
        }
      }
    }
  }

  // ----- API 路径搜索 -----
  else if (queryType === 'api_path') {
    const params: unknown[] = [`%${trimmedQuery}%`];
    let whereExtra = '';

    if (source) {
      whereExtra += ' AND source_id = ?';
      params.push(source);
    }
    if (mode) {
      whereExtra += ' AND dev_mode = ?';
      params.push(mode);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT * FROM documents WHERE api_path LIKE ?${whereExtra} LIMIT ?`,
      )
      .all(...params) as Document[];

    for (const doc of rows) {
      scoredRows.push({ doc, score: 50 });
    }
  }

  // ----- 关键词搜索 (FTS5) -----
  else {
    const tokenized = tokenizeForSearch(trimmedQuery);
    const tokens = tokenized.split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      const tookMs = Date.now() - startTime;
      logSearch(trimmedQuery, source, 0, undefined, tookMs);
      return { results: [], totalCount: 0, tookMs };
    }

    // FTS5 MATCH 语法：空格分隔 = 隐式 AND
    const matchExpr = tokens.join(' ');

    let whereExtra = '';
    const extraParams: unknown[] = [];
    if (source) {
      whereExtra += ' AND d.source_id = ?';
      extraParams.push(source);
    }
    if (mode) {
      whereExtra += ' AND d.dev_mode = ?';
      extraParams.push(mode);
    }

    try {
      const rows = db
        .prepare(
          `SELECT d.*, bm25(documents_fts) as fts_rank
           FROM documents_fts f
           JOIN documents d ON d.rowid = f.rowid
           WHERE documents_fts MATCH ?${whereExtra}
           LIMIT 200`,
        )
        .all(matchExpr, ...extraParams) as (Document & { fts_rank: number })[];

      for (const row of rows) {
        const { fts_rank, ...doc } = row;
        const score = computeScore(doc as Document, trimmedQuery, tokens, fts_rank);
        scoredRows.push({ doc: doc as Document, fts_rank, score });
      }
    } catch {
      // FTS5 MATCH 语法错误时 fallback 到 LIKE 搜索
      let whereExtra2 = '';
      const likeParams: unknown[] = [];
      for (const token of tokens) {
        whereExtra2 += ' AND (d.content LIKE ? OR d.title LIKE ?)';
        likeParams.push(`%${token}%`, `%${token}%`);
      }
      if (source) {
        whereExtra2 += ' AND d.source_id = ?';
        likeParams.push(source);
      }
      if (mode) {
        whereExtra2 += ' AND d.dev_mode = ?';
        likeParams.push(mode);
      }

      const rows = db
        .prepare(
          `SELECT d.* FROM documents d WHERE 1=1${whereExtra2} LIMIT 200`,
        )
        .all(...likeParams) as Document[];

      for (const doc of rows) {
        const score = computeScore(doc, trimmedQuery, tokens, undefined);
        scoredRows.push({ doc, score });
      }
    }
  }

  // ----- 排序 & 去重 & 截取 -----
  scoredRows.sort((a, b) => b.score - a.score);

  // 未指定 mode 时按 title+api_path 去重，保留得分最高的，其余 mode 合并
  const otherModesMap = new Map<number, string[]>();
  if (!mode) {
    const seen = new Map<string, { idx: number; modes: string[] }>();
    const deduped: ScoredRow[] = [];
    for (const sr of scoredRows) {
      const key = `${sr.doc.title}\0${sr.doc.api_path ?? ''}`;
      const existing = seen.get(key);
      if (existing) {
        if (sr.doc.dev_mode) existing.modes.push(sr.doc.dev_mode);
      } else {
        const entry = { idx: deduped.length, modes: [] as string[] };
        seen.set(key, entry);
        deduped.push(sr);
      }
    }
    scoredRows = deduped;
    // 记录每个位置的 other_modes（去重，排除与主文档相同的 mode）
    for (const entry of seen.values()) {
      const mainMode = deduped[entry.idx]?.doc.dev_mode;
      const unique = [...new Set(entry.modes)].filter(m => m !== mainMode);
      if (unique.length > 0) {
        otherModesMap.set(entry.idx, unique);
      }
    }
  }

  const totalCount = scoredRows.length;
  scoredRows = scoredRows.slice(0, limit);

  // ----- 构造 SearchResult -----
  const results: SearchResult[] = scoredRows.map(({ doc, score }, idx) => ({
    id: doc.id,
    source_id: doc.source_id,
    title: doc.title,
    path: doc.path,
    api_path: doc.api_path,
    dev_mode: doc.dev_mode,
    other_modes: otherModesMap.get(idx),
    doc_type: doc.doc_type,
    source_url: doc.source_url,
    last_updated: doc.last_updated,
    snippet: generateSnippet(doc.content, trimmedQuery),
    score: Math.round(score * 100) / 100,
  }));

  const tookMs = Date.now() - startTime;

  // 记录搜索日志
  logSearch(
    trimmedQuery,
    source,
    totalCount,
    results.length > 0 ? results[0].score : undefined,
    tookMs,
  );

  return { results, totalCount, tookMs };
}

// ---------------------------------------------------------------------------
// Format results as Markdown
// ---------------------------------------------------------------------------

export function formatSearchResults(
  query: string,
  results: SearchResult[],
  source: string | undefined,
  totalCount: number,
  tookMs: number,
): string {
  const sourceLabel = source ? sourceName(source) : '全部';

  if (results.length === 0) {
    const header = `## 搜索结果：${query}（来源：${sourceLabel}，共 0 条，耗时 ${tookMs}ms）`;
    const lines = [header, '', '暂无结果。建议：', ''];
    if (source) {
      lines.push(`- 当前限定了来源 \`${source}\`，尝试去掉 source 参数搜索全部平台`);
    }
    if (query.length > 4) {
      lines.push('- 关键词较长，尝试只保留核心功能名');
    }
    lines.push('- 换用同义词或不同表述');
    lines.push('- 查看已接入文档源：`GET /api/sources`');
    lines.push('- 浏览文档分类：`GET /api/categories`');
    return lines.join('\n');
  }

  const lines: string[] = [
    `## 搜索结果：${query}（来源：${sourceLabel}，共 ${totalCount} 条，耗时 ${tookMs}ms）`,
    '',
  ];

  results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.title} [score: ${r.score}]`);
    const modeLabel = r.dev_mode ?? '-';
    const modeExtra = r.other_modes?.length ? `（另见：${r.other_modes.join(', ')}）` : '';
    lines.push(
      `- 来源：${sourceName(r.source_id)} | 模式：${modeLabel}${modeExtra} | 路径：${r.path}`,
    );
    if (r.api_path) {
      lines.push(`- 接口：\`${r.api_path}\``);
    }
    lines.push(`- 摘要：${r.snippet}...`);
    lines.push(`- 文档ID：${r.id}`);
    if (r.source_url) {
      lines.push(`- 原文：${r.source_url}`);
    }
    if (r.last_updated) {
      lines.push(`- 更新：${r.last_updated}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}
