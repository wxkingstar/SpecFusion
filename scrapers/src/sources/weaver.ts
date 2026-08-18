import axios, { type AxiosInstance } from 'axios';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://weapp.eteams.cn';
const DOCS_PREFIX = '/build/opendoc/docs';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms）— 静态 CDN 资源，可以低一些 */
const REQUEST_DELAY = 150;

// ─── ProseMirror response interfaces ────────────────────────────────────────

interface CategoryNode {
  id: string | number;
  content: string;
  isFile: boolean;
  parentId: string | number;
  children?: CategoryNode[];
}

interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface PmNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PmMark[];
  content?: PmNode[];
}

// ─── Utility helpers ────────────────────────────────────────────────────────


function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

// ─── ProseMirror → Markdown conversion ──────────────────────────────────────

/** 把 text 节点的 marks 按优先级应用到文本上 */
function applyMarks(text: string, marks?: PmMark[]): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  for (const m of marks) {
    switch (m.type) {
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strong':
      case 'bold':
        out = `**${out}**`;
        break;
      case 'em':
      case 'italic':
        out = `*${out}*`;
        break;
      case 'link': {
        const href = (m.attrs?.href as string) || '';
        if (href && !/^javascript:/i.test(href)) {
          out = `[${out}](${href})`;
        }
        break;
      }
      // font-span 等样式 marks 直接忽略
    }
  }
  return out;
}

/** 递归收集节点的纯文本（用于表格单元格等） */
function collectText(node: PmNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') {
    return applyMarks(node.text || '', node.marks);
  }
  if (node.type === 'hard_break' || node.type === 'line_break') {
    return ' ';
  }
  const children = node.content || [];
  let out = '';
  for (const child of children) {
    out += collectText(child);
  }
  return out;
}

/** 把一个节点序列渲染为 Markdown */
function renderNodes(nodes: PmNode[] | undefined): string {
  if (!nodes || nodes.length === 0) return '';
  return nodes.map(renderNode).join('');
}

function renderNode(node: PmNode): string {
  switch (node.type) {
    case 'doc':
      return renderNodes(node.content);

    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(node.attrs?.level) || 2));
      const text = collectText(node).trim();
      return text ? `\n${'#'.repeat(level)} ${text}\n\n` : '';
    }

    case 'paragraph': {
      const text = renderNodes(node.content).trim();
      return text ? `\n${text}\n\n` : '\n';
    }

    case 'text':
      return applyMarks(node.text || '', node.marks);

    case 'hard_break':
    case 'line_break':
      return '\n';

    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type === 'ordered_list';
      const items = (node.content || [])
        .map((li, idx) => {
          const prefix = ordered ? `${idx + 1}. ` : '- ';
          // list_item 内通常是 paragraph
          const inner = renderNodes(li.content).trim().replace(/\n+/g, ' ');
          return `${prefix}${inner}`;
        })
        .join('\n');
      return items ? `\n${items}\n\n` : '';
    }

    case 'list_item': {
      // 一般不会单独渲染，fallback
      const inner = renderNodes(node.content).trim();
      return inner ? `- ${inner}\n` : '';
    }

    case 'fence':
    case 'code_block': {
      const lang = (node.attrs?.language as string) || '';
      const text = collectText(node);
      return `\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const inner = renderNodes(node.content).trim();
      if (!inner) return '';
      const quoted = inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      return `\n${quoted}\n\n`;
    }

    case 'table':
      return renderTable(node);

    case 'image': {
      const src = (node.attrs?.src as string) || '';
      const alt = (node.attrs?.alt as string) || '';
      return src ? `![${alt}](${src})` : '';
    }

    case 'horizontal_rule':
    case 'hr':
      return '\n---\n\n';

    default:
      // 兜底：尝试渲染子节点，不认识的节点不打印类型
      return renderNodes(node.content);
  }
}

function renderTable(table: PmNode): string {
  const rows: string[][] = [];
  let maxCols = 0;

  for (const row of table.content || []) {
    if (row.type !== 'table_row') continue;
    const cells: string[] = [];
    for (const cell of row.content || []) {
      if (cell.type !== 'table_cell' && cell.type !== 'table_header') continue;
      const text = collectText(cell).trim();
      cells.push(escapeCell(text));
    }
    if (cells.length > maxCols) maxCols = cells.length;
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  const lines: string[] = [];
  const header = rows[0];
  while (header.length < maxCols) header.push('');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    while (r.length < maxCols) r.push('');
    lines.push(`| ${r.join(' | ')} |`);
  }
  return `\n${lines.join('\n')}\n\n`;
}

// ─── WeaverSource class ─────────────────────────────────────────────────────

export class WeaverSource implements DocSource {
  id = 'weaver';
  name = '泛微 e-teams 开放平台';

  private client: AxiosInstance;
  private requestCount = 0;
  /** 动态解析的最新版本号，如 "10.0.2026.0201.01" */
  private version: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        langtype: 'zh_CN',
        Referer: `${BASE_URL}/sp/opendoc/freepass/`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[weaver] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  private async resolveVersion(): Promise<string> {
    if (this.version) return this.version;
    const resp = await this.client.get<Array<{ id: string; content: string }>>(
      `${DOCS_PREFIX}/version.json`,
      { params: { t: Date.now() } },
    );
    const list = resp.data;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('获取版本列表失败：响应为空');
    }
    // 版本列表按发布顺序，最新在末尾
    this.version = list[list.length - 1].id;
    console.log(`[weaver] 使用最新版本: ${this.version}`);
    return this.version;
  }

  private async fetchCategoryTree(): Promise<CategoryNode[]> {
    const version = await this.resolveVersion();
    const resp = await this.client.get<CategoryNode[]>(
      `${DOCS_PREFIX}/${version}/categorys/zh_cn.json`,
      { params: { t: Date.now() } },
    );
    return resp.data;
  }

  private async fetchDocJson(docId: string): Promise<PmNode> {
    await this.throttle();
    const version = await this.resolveVersion();
    const resp = await this.client.get<PmNode>(
      `${DOCS_PREFIX}/${version}/files/f${docId}.zh_cn.json`,
      { params: { t: Date.now() } },
    );
    return resp.data;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[weaver] 获取文档目录树...');
    const tree = await this.fetchCategoryTree();
    const entries: DocEntry[] = [];

    const version = await this.resolveVersion();

    const walk = (nodes: CategoryNode[], pathPrefix: string[]) => {
      for (const n of nodes) {
        const id = String(n.id);
        const title = (n.content || '').trim() || `文档${id}`;
        if (n.isFile) {
          const path = [...pathPrefix, title].join('/');
          entries.push({
            path,
            title,
            docType: 'api_reference',
            sourceUrl: `${BASE_URL}/sp/opendoc/freepass/${version}/zh_cn/${id}`,
            platformId: id,
          });
        }
        if (n.children && n.children.length > 0) {
          const nextPrefix = n.isFile ? pathPrefix : [...pathPrefix, title];
          walk(n.children, nextPrefix);
        }
      }
    };

    walk(tree, []);
    console.log(`[weaver] 目录加载完成: ${entries.length} 篇文档`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const docId = entry.platformId;
    if (!docId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    const doc = await this.fetchDocJson(docId);

    const sections: string[] = [];
    sections.push(`# ${entry.title}\n`);

    // 路径分类（除掉标题部分）
    const pathParts = entry.path.split('/');
    if (pathParts.length > 1) {
      sections.push(`分类：${pathParts.slice(0, -1).join(' / ')}\n`);
    }

    const body = renderNodes(doc.content).trim();
    if (body) sections.push(body);

    let markdown = sections.join('\n');
    markdown = collapseBlankLines(markdown).trim();

    // 从 Markdown 中尝试提取 API 请求路径
    const apiPath = extractApiPath(markdown);

    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    return {
      markdown,
      apiPath,
      metadata: {
        tokenizedTitle,
        tokenizedContent,
      },
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}

// ─── API path extraction helper ─────────────────────────────────────────────

/**
 * 尝试从正文中提取 API 请求 URL 的 path 部分。
 * 泛微文档常见模式：请求URL：{OpenApiOrigin}/oauth2/access_token
 */
function extractApiPath(markdown: string): string | undefined {
  // 匹配形如「请求URL: - [{OpenApiOrigin}/oauth2/access_token](...)」或直接  /oauth2/access_token
  // 提取以 / 开头、由字母数字 _ - . 组成的 URL 路径段
  const re = /(?:请求URL|请求Url|请求url|Url|URL)[：:]\s*[\s\S]{0,200}?(?:\{[^}]+\})?(\/[A-Za-z0-9_\-./]+)/;
  const match = markdown.match(re);
  if (match) {
    const p = match[1].replace(/[.)\]]+$/, '').trim();
    if (p.length > 1 && p.length < 200) return p;
  }
  return undefined;
}
