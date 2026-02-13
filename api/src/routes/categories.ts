import type { FastifyInstance } from 'fastify';
import { getDb } from '../services/doc-store.js';

const SOURCE_NAME_MAP: Record<string, string> = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
};

function sourceName(sourceId: string): string {
  return SOURCE_NAME_MAP[sourceId] ?? sourceId;
}

export async function categoriesRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { source?: string };
  }>('/categories', async (request, reply) => {
    const { source } = request.query;
    const db = getDb();

    let sql = `
      SELECT source_id,
             SUBSTR(path, 1, INSTR(path || '/', '/') - 1) as category,
             COUNT(*) as cnt
      FROM documents
    `;
    const params: unknown[] = [];

    if (source) {
      sql += ' WHERE source_id = ?';
      params.push(source);
    }

    sql += ' GROUP BY source_id, category ORDER BY source_id, cnt DESC';

    const rows = db.prepare(sql).all(...params) as {
      source_id: string;
      category: string;
      cnt: number;
    }[];

    if (rows.length === 0) {
      reply.type('text/markdown; charset=utf-8');
      return source
        ? `## 文档分类（${sourceName(source)}）\n\n暂无数据。`
        : '## 文档分类\n\n暂无数据。';
    }

    // 按 source_id 分组
    const grouped = new Map<string, { category: string; cnt: number }[]>();
    for (const row of rows) {
      const list = grouped.get(row.source_id) ?? [];
      list.push({ category: row.category, cnt: row.cnt });
      grouped.set(row.source_id, list);
    }

    const lines: string[] = [];

    for (const [sid, categories] of grouped) {
      lines.push(`## ${sourceName(sid)}（${sid}）`);
      lines.push('');
      lines.push('| 分类 | 文档数量 |');
      lines.push('|------|---------|');
      for (const cat of categories) {
        lines.push(`| ${cat.category || '(根目录)'} | ${cat.cnt} |`);
      }
      lines.push('');
    }

    reply.type('text/markdown; charset=utf-8');
    return lines.join('\n');
  });

  // 分类下钻 — 列出某个分类下的文档
  fastify.get<{
    Params: { source: string; category: string };
    Querystring: { mode?: string; limit?: string };
  }>('/categories/:source/:category', async (request, reply) => {
    const { source, category } = request.params;
    const { mode, limit: rawLimit } = request.query;
    const limit = Math.min(parseInt(rawLimit || '50', 10) || 50, 100);
    const db = getDb();

    const params: unknown[] = [source, category];
    let whereExtra = '';

    if (mode) {
      whereExtra += ' AND dev_mode = ?';
      params.push(mode);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT id, title, api_path, dev_mode, doc_type, source_url, last_updated
         FROM documents
         WHERE source_id = ?
           AND SUBSTR(path, 1, INSTR(path || '/', '/') - 1) = ?${whereExtra}
         ORDER BY path
         LIMIT ?`,
      )
      .all(...params) as {
      id: string;
      title: string;
      api_path?: string;
      dev_mode?: string;
      doc_type: string;
      source_url?: string;
      last_updated?: string;
    }[];

    reply.type('text/markdown; charset=utf-8');

    if (rows.length === 0) {
      return `## ${sourceName(source)} / ${category}\n\n该分类下暂无文档。`;
    }

    const lines: string[] = [
      `## ${sourceName(source)} / ${category}（共 ${rows.length} 条）`,
      '',
      '| 标题 | 接口路径 | 模式 | 文档ID |',
      '|------|---------|------|--------|',
    ];

    for (const row of rows) {
      const apiPath = row.api_path ? `\`${row.api_path}\`` : '-';
      lines.push(`| ${row.title} | ${apiPath} | ${row.dev_mode ?? '-'} | ${row.id} |`);
    }

    return lines.join('\n');
  });
}
