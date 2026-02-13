/**
 * 文档摘要生成器
 * 从 Markdown 全文中提取结构化摘要（~1KB）
 */

// 权限说明相关关键词，用于跳过权限段落
const PERMISSION_KEYWORDS = [
  '权限说明', '权限要求', '使用条件', '调用权限', '接口权限',
  '应用权限', '通讯录权限', '数据权限', 'permission', 'scope',
];

// HTTP 方法 + 路径模式
const API_PATH_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s)]+)/i;

// 企业微信路径模式
const WECOM_PATH_RE = /\/cgi-bin\/[^\s)]+/;

// 飞书路径模式
const FEISHU_PATH_RE = /\/open-apis\/[^\s)]+/;

/**
 * 从 Markdown 全文生成结构化摘要
 */
export function generateSummary(
  content: string,
  docId: string,
  sourceId: string,
  docTitle?: string,
  docApiPath?: string,
): string {
  const lines = content.split('\n');
  const parts: string[] = [];

  // 1. 提取元信息注释
  const metaLines = lines.filter(l => l.startsWith('<!--'));
  for (const ml of metaLines) {
    parts.push(ml);
  }
  if (metaLines.length > 0) parts.push('');

  // 2. 提取标题 — 优先使用 DB 字段（content 中可能提取到模板占位符）
  const title = docTitle || extractTitle(lines);
  if (title) {
    parts.push(`# ${title}`);
    parts.push('');
  }

  // 3. 提取描述（标题后第一段非权限说明文本）
  const description = extractDescription(lines);
  if (description) {
    parts.push(`> ${description}`);
    parts.push('');
  }

  // 4. 提取接口信息 — 正则提取失败时回退到 DB 字段
  let apiInfo = extractApiInfo(content);
  if (!apiInfo && docApiPath) {
    const methodMatch = content.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i);
    apiInfo = { method: methodMatch?.[1]?.toUpperCase(), path: docApiPath };
  }
  if (apiInfo) {
    parts.push('## 接口信息');
    parts.push('');
    if (apiInfo.method) {
      parts.push(`- **方法**：${apiInfo.method}`);
    }
    if (apiInfo.path) {
      parts.push(`- **路径**：\`${apiInfo.path}\``);
    }

    // 添加原文链接（从元信息注释中提取）
    const sourceUrlMatch = content.match(/<!--\s*source_url:\s*(\S+)\s*-->/);
    if (sourceUrlMatch) {
      parts.push(`- **原文**：${sourceUrlMatch[1]}`);
    }
    parts.push('');
  }

  // 5. 提取第一个参数表格（最多 10 行）
  const table = extractFirstTable(lines, 10);
  if (table) {
    parts.push('## 请求参数');
    parts.push('');
    parts.push(table);
    parts.push('');
  }

  // 6. 提取 JSON 代码块示例（最多 2 个，每个截断到 500 字符）
  const jsonExamples = extractJsonExamples(lines);
  if (jsonExamples.length > 0) {
    parts.push('## 示例');
    parts.push('');
    for (const ex of jsonExamples) {
      if (ex.label) {
        parts.push(`**${ex.label}**`);
        parts.push('');
      }
      parts.push('```json');
      parts.push(ex.code);
      parts.push('```');
      parts.push('');
    }
  }

  // 7. 添加获取全文提示
  parts.push(`*（完整参数和代码示例请获取全文：\`/doc/${docId}\`）*`);

  return parts.join('\n');
}

function extractTitle(lines: string[]): string | null {
  for (const line of lines) {
    // 跳过注释行
    if (line.startsWith('<!--')) continue;
    const match = line.match(/^#\s+(.+)/);
    if (match) return match[1].trim();
  }
  return null;
}

function extractDescription(lines: string[]): string | null {
  let foundTitle = false;
  let skipBlank = true;

  for (const line of lines) {
    if (line.startsWith('<!--')) continue;

    // 找到标题
    if (!foundTitle && /^#\s+/.test(line)) {
      foundTitle = true;
      skipBlank = true;
      continue;
    }

    if (!foundTitle) continue;

    const trimmed = line.trim();

    // 跳过标题后的空行
    if (skipBlank && !trimmed) continue;
    skipBlank = false;

    // 跳过二级及以下标题
    if (/^#{2,}/.test(trimmed)) break;

    // 跳过权限说明段落
    if (isPermissionParagraph(trimmed)) continue;

    // 跳过空行
    if (!trimmed) continue;

    // 找到了有效描述
    const desc = trimmed
      .replace(/^>\s*/, '')   // 移除引用标记
      .replace(/\*\*/g, '')   // 移除加粗
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // 链接→纯文本

    if (desc.length > 200) {
      return desc.slice(0, 197) + '...';
    }
    return desc;
  }
  return null;
}

function isPermissionParagraph(text: string): boolean {
  return PERMISSION_KEYWORDS.some(kw => text.includes(kw));
}

function extractApiInfo(content: string): { method?: string; path?: string } | null {
  // 优先匹配显式的 HTTP 方法 + 路径
  const explicit = content.match(API_PATH_RE);
  if (explicit) {
    return { method: explicit[1].toUpperCase(), path: explicit[2] };
  }

  // 尝试匹配企业微信路径
  const wecom = content.match(WECOM_PATH_RE);
  if (wecom) {
    return { path: wecom[0] };
  }

  // 尝试匹配飞书路径
  const feishu = content.match(FEISHU_PATH_RE);
  if (feishu) {
    return { path: feishu[0] };
  }

  return null;
}

function extractFirstTable(lines: string[], maxRows: number): string | null {
  let tableStart = -1;
  let headerFound = false;
  const tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (tableStart === -1) {
      // 寻找表格开始（含 | 的行）
      if (line.startsWith('|') && line.endsWith('|')) {
        tableStart = i;
        tableLines.push(lines[i]);
      }
      continue;
    }

    // 已经在表格中
    if (line.startsWith('|') && line.endsWith('|')) {
      // 检测分隔行
      if (!headerFound && /^\|[\s\-:|]+\|$/.test(line)) {
        headerFound = true;
        tableLines.push(lines[i]);
        continue;
      }

      if (headerFound) {
        // 数据行计数（不包含表头和分隔行）
        if (tableLines.length - 2 >= maxRows) {
          tableLines.push(`| ... | ... | ... | *（共 ${countRemainingRows(lines, i)} 行更多，请获取全文查看）* |`);
          break;
        }
      }
      tableLines.push(lines[i]);
    } else {
      // 表格结束
      if (headerFound && tableLines.length > 2) {
        break;
      }
      // 不是有效表格，重置
      tableStart = -1;
      headerFound = false;
      tableLines.length = 0;
    }
  }

  if (tableLines.length > 2 && headerFound) {
    return tableLines.join('\n');
  }
  return null;
}

interface JsonExample {
  label: string | null;
  code: string;
}

/**
 * 从文档内容中提取 JSON 代码块示例
 * 最多提取 2 个，每个截断到 500 字符
 */
function extractJsonExamples(contentLines: string[]): JsonExample[] {
  const examples: JsonExample[] = [];
  const fenceRe = /^```json\s*$/;
  const endFenceRe = /^```\s*$/;

  let i = 0;
  while (i < contentLines.length && examples.length < 2) {
    const trimmed = contentLines[i].trim();
    if (fenceRe.test(trimmed)) {
      // 找到代码块前最近的标题行作为 label
      let label: string | null = null;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prev = contentLines[j].trim();
        if (!prev) continue;
        // 标题行
        const headingMatch = prev.match(/^#{1,6}\s+(.+)/);
        if (headingMatch) {
          label = headingMatch[1].trim();
          break;
        }
        // 加粗行或普通文本行（紧邻代码块的描述性文字）
        if (prev.length < 50) {
          label = prev.replace(/\*\*/g, '').replace(/[:#]/g, '').trim();
          break;
        }
        break;
      }

      // 收集代码块内容
      const codeLines: string[] = [];
      i++;
      while (i < contentLines.length) {
        if (endFenceRe.test(contentLines[i].trim())) {
          break;
        }
        codeLines.push(contentLines[i]);
        i++;
      }

      let code = codeLines.join('\n').trim();
      if (code.length > 0) {
        if (code.length > 500) {
          code = code.slice(0, 497) + '...';
        }
        examples.push({ label, code });
      }
    }
    i++;
  }

  return examples;
}

function countRemainingRows(lines: string[], startIdx: number): number {
  let count = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
