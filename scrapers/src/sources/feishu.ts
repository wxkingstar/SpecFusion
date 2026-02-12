import axios, { type AxiosInstance } from 'axios';
import PQueue from 'p-queue';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ── 常量 ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://open.feishu.cn';
const DIRECTORY_URL = `${BASE_URL}/api/tools/docment/directory_list`;
const URI_MAP_URL = `${BASE_URL}/document_portal/v1/document_portal/v1/document/uri/mapping?lang=zh-CN`;
const DOCUMENT_DETAIL_URL = `${BASE_URL}/api/tools/document/detail`;
const DOC_BASE_URL = `${BASE_URL}/document`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 1200;
const CONCURRENCY = 6;

const ROOT_CONFIGS: RootConfig[] = [
  { fullPath: '/uAjLw4CM/ukzMukzMukzM', title: '开发指南' },
  { fullPath: '/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM', title: '开发教程' },
  { fullPath: '/uAjLw4CM/ukTMukTMukTM', title: '服务端 API' },
  { fullPath: '/uAjLw4CM/uYjL24iN', title: '客户端 API' },
  { fullPath: '/mcp_open_tools', title: 'MCP' },
];

// ── 类型 ──────────────────────────────────────────────────────────────

interface RootConfig {
  fullPath: string;
  title: string;
}

interface TreeNode {
  id: string;
  name?: string;
  fullPath?: string;
  md_href?: string;
  type?: string;
  items?: TreeNode[];
  updateTime?: number;
}

interface TreeIndex {
  mapById: Map<string, TreeNode>;
  mapByFullPath: Map<string, TreeNode>;
  parents: Map<string, string>;
}

interface DocumentResponse {
  content: string;
  updateTime?: number;
}

// ── 工具函数 ──────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function timestampToDate(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const millis = value > 1e12 ? value : value * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function detectLocale(fullPath: string, aliasPath: string, docName: string): string {
  if (docName && /[\u4e00-\u9fff]/.test(docName)) return 'zh';
  const candidates = [fullPath, aliasPath].filter(Boolean).map((s) => s.toLowerCase()).join(' ');
  if (candidates.includes('zh')) return 'zh';
  if (candidates.includes('en')) return 'en';
  return 'en';
}

function detectDocType(fullPath: string): string | undefined {
  if (/\/event\//i.test(fullPath)) return 'event';
  if (/\/card\//i.test(fullPath)) return 'card_template';
  if (/\/server-api\//i.test(fullPath)) return 'api_reference';
  if (/\/client-api\//i.test(fullPath)) return 'api_reference';
  if (/\/guide\//i.test(fullPath)) return 'guide';
  if (/\/tutorial\//i.test(fullPath)) return 'guide';
  return undefined;
}

function getDocumentUrl(fullPath: string, aliasMap: Map<string, string>): string {
  const mapped = aliasMap.get(fullPath);
  const pathPart = mapped || fullPath;
  return `${BASE_URL}/document${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`;
}

// ── 目录索引 ──────────────────────────────────────────────────────────

function indexTree(
  nodes: TreeNode[],
  parentId: string | null = null,
  mapById: Map<string, TreeNode> = new Map(),
  mapByFullPath: Map<string, TreeNode> = new Map(),
  parents: Map<string, string> = new Map(),
): TreeIndex {
  for (const node of nodes) {
    if (!node || !node.id) continue;
    mapById.set(node.id, node);
    if (node.fullPath) {
      mapByFullPath.set(node.fullPath, node);
    }
    if (parentId) {
      parents.set(node.id, parentId);
    }
    if (Array.isArray(node.items) && node.items.length > 0) {
      indexTree(node.items, node.id, mapById, mapByFullPath, parents);
    }
  }
  return { mapById, mapByFullPath, parents };
}

// ── 内容转换管线 ──────────────────────────────────────────────────────

type Transformer = (input: string, locale: string) => string;

function applyTransformers(transformers: Transformer[], input: string, locale: string): string {
  return transformers.reduce((acc, fn) => fn(acc, locale), input);
}

// ── PRIMARY_TRANSFORMERS ──────────────────────────────────────────────

const PRIMARY_TRANSFORMERS: Transformer[] = [
  // <strong> → **bold**
  (input) => input.replace(/<strong>([\s\S]+?)<\/strong>/g, '**$1**'),
  // <a href> → [text](href)
  (input) =>
    input.replace(/<a[\s\S]+?href="([^"]+)">([\s\S]+?)<\/a>/g, (_m, href, text) => `[${text}](${href})`),
  // <md-text> → inner
  (input) => input.replace(/<md-text[^>]*>([\s\S]+?)<\/md-text>/g, '$1'),
  // <md-enum-item key="..."> → list item
  (input) =>
    input.replace(
      /<md-enum-item[\s]*([\S\s]*?)[\s]*>([\s\S]+?)<\/md-enum-item>/g,
      (_m, attrs: string, text: string) => {
        const keyMatch = attrs ? attrs.match(/key="([^"]+)"/) : null;
        const key = keyMatch ? keyMatch[1] : '';
        return key ? `- ${key}：${text}` : `- ${text}`;
      },
    ),
  // <md-enum> → inner
  (input) => input.replace(/<md-enum[\s\S]*?>([\s\S]+?)<\/md-enum>/g, '$1'),
  // <md-version> → inner
  (input) => input.replace(/<md-version[^>]*>([\s\S]+?)<\/md-version>/g, '$1'),
  // <md-tooltip> → **bold**
  (input) => input.replace(/<md-tooltip[\s\S]*?>([\s\S]+?)<\/md-tooltip>/g, '**$1**'),
  // <div> → inner + newline
  (input) => input.replace(/<div[\s\S]+?>([\s\S]+?)<\/div>/g, '$1\n'),
  // <b> → **bold**
  (input) => input.replace(/<b>([\s\S]+?)<\/b>/g, '**$1**'),
  // <span> → inner
  (input) => input.replace(/<span[^>]*>([\s\S]+?)<\/span>/g, '$1'),
  // </br> → newline
  (input) => input.replace(/<\/br>/g, '\n'),
  // <font> → inner
  (input) => input.replace(/<font[\s\S]*?>([\s\S]+?)<\/font>/g, '$1'),
  // <p> → inner + newline
  (input) => input.replace(/<p[^>]*>([\s\S]+?)<\/p>/g, '$1\n'),
  // <md-perm> → inner(name)
  (input) =>
    input.replace(/<md-perm[^>]*>([\s\S]+?)<\/md-perm>/g, (match, inner: string) => {
      const nameMatch = match.match(/name="([^"]+)"/);
      return nameMatch ? `${inner}(${nameMatch[1]})` : inner;
    }),
  // <md-app-support> → app type labels
  (input, locale) =>
    input.replace(/<md-app-support[^>]*>[\s\S]*?<\/md-app-support>/g, (match) => {
      const parts: string[] = [];
      const isZh = locale.startsWith('zh');
      if (match.includes('custom')) parts.push(isZh ? '自建应用' : 'Custom App');
      if (match.includes('isv')) parts.push(isZh ? '商店应用' : 'Store App');
      return parts.join('、');
    }),
  // <md-tag href="..."> → [text](href) or `text`
  (input) =>
    input.replace(/<md-tag[^>]*>([\s\S]*?)<\/md-tag>/g, (match, text: string) => {
      const hrefMatch = match.match(/href="([^"]+)"/);
      return hrefMatch ? `[${text}](${hrefMatch[1]})` : `\`${text}\``;
    }),
  // trim whitespace-only lines
  (input) =>
    input
      .split('\n')
      .map((line) => line.replace(/^[\s\r\t]+$/, ''))
      .join('\n'),
  // cleanup stray closing tags
  (input) => input.replace(/<\/md-enum-item>/g, ''),
  (input) => input.replace(/<\/md-alert>/g, ''),
  (input) => input.replace(/<\/md-code.*?>/g, ''),
  (input) => input.replace(/<md-code.*?>/g, ''),
  (input) => input.replace(/<md-td.*?>/g, ''),
  (input) => input.replace(/<\/md-td>/g, ''),
];

// ── 表格转换 ──────────────────────────────────────────────────────────

const TABLE_OUTER_PATTERNS: RegExp[] = [
  /<md-table[\s\S]*?>/g,
  /<\/md-table>/g,
  /<table[\s\S]*?>/g,
  /<\/table>/g,
  /<md-dt-table[\s\S]*?>/g,
  /<\/md-dt-table>/g,
  /<thead[\s\S]*?>/g,
  /<\/thead>/g,
  /<md-thead[\s\S]*?>/g,
  /<\/md-thead>/g,
  /<md-dt-thead[\s\S]*?>/g,
  /<\/md-dt-thead>/g,
  /<tbody[\s\S]*?>/g,
  /<\/tbody>/g,
  /<md-tbody[\s\S]*?>/g,
  /<\/md-tbody>/g,
  /<md-dt-tbody[\s\S]*?>/g,
  /<\/md-dt-tbody>/g,
  /<colgroup[\s\S]*?>[\s\S]+?<\/colgroup>/g,
];

const TABLE_ROW_PATTERNS: RegExp[] = [
  /<tr[\s\S]*?>/g,
  /<md-tr[\s\S]*?>/g,
  /<md-dt-tr[\s\S]*?>/g,
];

const TABLE_CELL_PATTERNS: RegExp[] = [
  /<td[\s\S]*?>/g,
  /<md-td[\s\S]*?>/g,
  /<md-dt-td[\s\S]*?>/g,
  /<md-th[\s\S]*?>/g,
  /<th[\s\S]*?>/g,
  /<md-dt-th[\s\S]*?>/g,
];

function convertMdTable(html: string, locale: string): string {
  let content = html;
  for (const pattern of TABLE_OUTER_PATTERNS) {
    content = content.replace(pattern, '');
  }

  const rawRows = content
    .split(/<\/tr>\s*|<\/md-tr>\s*|<\/md-dt-tr>\s*/i)
    .map((row) => row.trim())
    .filter(Boolean);

  const rows: (string | string[])[] = rawRows
    .map((row) => {
      let cleanedRow = row;
      for (const pattern of TABLE_ROW_PATTERNS) {
        cleanedRow = cleanedRow.replace(pattern, '');
      }

      const rawCells = cleanedRow
        .split(/<\/md-td>\s*|<\/td>\s*|<\/md-dt-td>\s*|<\/md-th>\s*|<\/th>\s*|<\/md-dt-th>\s*/i)
        .map((cell) => cell.trim())
        .filter(Boolean);

      const processedCells = rawCells.map((cell) => {
        let text = cell;
        for (const pattern of TABLE_CELL_PATTERNS) {
          text = text.replace(pattern, '');
        }
        text = applyTransformers(PRIMARY_TRANSFORMERS, text, locale);
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/^[\s\n]+/g, '').replace(/[\s\n]+$/g, '');
        text = text.replace(/\n{2,}/g, '\n');
        return text.replace(/\n/g, '<br>');
      });

      if (!processedCells.length) return '';
      if (processedCells.length === 1) return processedCells[0];
      return processedCells;
    })
    .filter((row) => row !== '');

  if (!rows.length) return '';

  const lines: string[] = [];
  const firstRow = rows[0];

  if (Array.isArray(firstRow)) {
    const header = firstRow.map((cell) => cell.replace(/<br>/g, '<br>'));
    const headerLine = header.join(' | ').replace(/<br>/g, '<br>');
    const separator = header.map(() => '---').join(' | ');
    lines.push(headerLine);
    lines.push(separator);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (Array.isArray(row)) {
        lines.push(
          row
            .map((cell) => cell.replace(/<br>/g, '<br>'))
            .join(' | ')
            .replace(/<br>/g, '<br>'),
        );
      } else {
        lines.push(String(row).replace(/<br>/g, '<br>'));
      }
    }
  } else {
    rows.forEach((row) => {
      lines.push(Array.isArray(row) ? row.join(' | ') : String(row));
    });
  }

  return `\n\n${lines.join('\n').replace(/<br>/g, '  \n')}\n\n`;
}

// ── SECONDARY_TRANSFORMERS ────────────────────────────────────────────

const SECONDARY_TRANSFORMERS: Transformer[] = [
  // strip HTML comments
  (input) => input.replace(/\n?<!--.*?-->/g, ''),
  // strip ::: note / ::: html / :::
  (input) => input.replace(/\n\s*:::\s*note?/g, ''),
  (input) => input.replace(/\n\s*:::\s*html/g, '').replace(/\n\s*:::/g, ''),
  // strip <md-video>
  (input) => input.replace(/<md-video[^>]*>[\s\S]+?<\/md-video>/g, ''),
  // strip <img>
  (input) => input.replace(/<img[^>]*>/g, ''),
  // <md-alert> → **注意事项**：inner
  (input, locale) =>
    input.replace(/<md-alert[\s\S]+?>([\s\S]*?)<\/md-alert>/g, (_match, inner: string) => {
      const text = inner.trim();
      if (!text) return text;
      const label = locale.startsWith('zh') ? '注意事项' : 'Notice';
      return `**${label}**：${text}`;
    }),
  // <md-code-json> → json code block
  (input) =>
    input.replace(
      /<md-code-json[^>]*>([\s\S]*?)<\/md-code-json>/g,
      (_m, inner: string) => `\`\`\`json\n${inner.trim()}\n\`\`\`\n`,
    ),
  // <md-block-api> → json code block
  (input) =>
    input.replace(
      /<md-block-api[^>]*>([\s\S]*?)<\/md-block-api>/g,
      (_m, inner: string) => `\`\`\`json\n${inner.trim()}\n\`\`\`\n`,
    ),
  // strip "尝试一下" / "使用示例" / "Try it" links
  (input) =>
    input.replace(
      /\{(尝试一下|使用示例|Try it)\}\(url=\/api\/tools\/api_explore\/api_explore_config\?.*?\)/g,
      '',
    ),
  // <md-preview-app> → link
  (input) =>
    input.replace(
      /<md-preview-app[\s\S]*?>([\s\S]+?)<\/md-preview-app>/g,
      (match, inner: string) => {
        const appIdMatch = match.match(/appId="([^"]+)"/);
        const pathMatch = match.match(/path="([^"]+)"/);
        const typeMatch = match.match(/type="([^"]+)"/);
        if (!appIdMatch || !pathMatch || !typeMatch) return inner;
        const appId = appIdMatch[1];
        const encodedPath = encodeURIComponent(pathMatch[1]);
        if (typeMatch[1] === 'webApp') {
          return `[${inner}](https://applink.feishu.cn/client/web_app/open?appId=${appId}&path=${encodedPath})`;
        }
        return `[${inner}](https://applink.feishu.cn/client/mini_program/open?appId=${appId}&path=${encodedPath})`;
      },
    ),
  // <md-table> / <table> / <md-dt-table> (closed) → markdown table
  (input, locale) =>
    input.replace(
      /<md-table[\s\S]*?>([\s\S]+?)<\/md-table>|<table[\s\S]*?>([\s\S]+?)<\/table>|<md-dt-table[\s\S]*?>([\s\S]+?)<\/md-dt-table>/g,
      (match) => convertMdTable(match, locale),
    ),
  // <md-table> / <table> / <md-dt-table> (unclosed / trailing) → markdown table
  (input, locale) =>
    input.replace(
      /<md-table[\s\S]*?>[\s\S]+|<table[\s\S]*?>[\s\S]+|<md-dt-table[\s\S]*?>[\s\S]+/g,
      (match) => convertMdTable(match, locale),
    ),
];

// ── transformContent ──────────────────────────────────────────────────

function transformContent(raw: string, locale: string): string {
  if (!raw) return '';
  // /ssl:ttdoc → full document URL
  let result = raw.replace(/\/ssl:ttdoc/g, DOC_BASE_URL);
  // 两轮转换器：先 SECONDARY 再 PRIMARY
  result = applyTransformers(SECONDARY_TRANSFORMERS, result, locale);
  result = applyTransformers(PRIMARY_TRANSFORMERS, result, locale);
  // 清理多余空行
  result = result.replace(/\n\s*\n[\s]+/g, '\n\n');
  // 修复相对协议链接
  result = result.replace(/(!?\[[^\]]*\]\()\/\//g, '$1https://');
  // 修复表格标题行
  result = result.replace(
    /^\s*基本\s*\|\s*\r?\n\s*---\s*\|\s*---(\r?\n?)/gm,
    (_match, newline: string) => `名称 | 值\n---|---${newline || ''}`,
  );
  // strip 残留的未知 <md-*> 标签（保留内文本，移除标签本身）
  result = result.replace(/<md-[a-z][a-z0-9-]*[^>]*>([\s\S]*?)<\/md-[a-z][a-z0-9-]*>/g, '$1');
  result = result.replace(/<md-[a-z][a-z0-9-]*[^>]*\/?>/g, '');
  return result.trim();
}

// ── apiPath 提取 ──────────────────────────────────────────────────────

const API_PATH_REGEX = /(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/open-apis\/[^\s)}\]"']+)/i;

function extractApiPath(markdown: string): string | undefined {
  const match = markdown.match(API_PATH_REGEX);
  return match ? match[1] : undefined;
}

// ── 事件名提取 ────────────────────────────────────────────────────────

const EVENT_NAME_REGEX = /事件名[：:]\s*`?([a-z][a-z0-9_.]+)`?/i;

function extractEventName(markdown: string): string | undefined {
  const match = markdown.match(EVENT_NAME_REGEX);
  return match ? match[1] : undefined;
}

// ── FeishuSource ──────────────────────────────────────────────────────

/**
 * 飞书文档源适配器
 * 迁移自 doc-hub-mcp/scripts/feishu-scraper.js
 */
export class FeishuSource implements DocSource {
  id = 'feishu';
  name = '飞书';

  private http: AxiosInstance;
  private aliasMap: Map<string, string> = new Map();
  private treeIndex: TreeIndex | null = null;

  constructor() {
    this.http = axios.create({
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 20000,
    });
  }

  // ── fetchCatalog ──────────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    const [tree, aliasMap] = await Promise.all([
      this.fetchDirectoryTree(),
      this.fetchUriMap(),
    ]);

    this.aliasMap = aliasMap;
    this.treeIndex = indexTree(tree);

    const entries: DocEntry[] = [];

    for (const rootConfig of ROOT_CONFIGS) {
      const rootNode = this.treeIndex.mapByFullPath.get(rootConfig.fullPath);
      if (!rootNode) {
        console.warn(`[feishu] 未找到根节点: ${rootConfig.title} (${rootConfig.fullPath})，跳过`);
        continue;
      }
      this.collectLeafEntries(rootNode.items || [], [rootConfig.title], entries);
    }

    return entries;
  }

  private collectLeafEntries(
    children: TreeNode[],
    pathSegments: string[],
    entries: DocEntry[],
  ): void {
    for (const child of children) {
      if (!child) continue;
      const name = child.name || child.id;
      const currentPath = [...pathSegments, name].join('/');

      // 有 md_href 表示叶子文档节点
      if (child.md_href || child.type === 'DocumentType') {
        const fullPath = child.fullPath || '';
        const sourceUrl = getDocumentUrl(fullPath, this.aliasMap);
        const docType = detectDocType(fullPath);
        const lastUpdated = child.updateTime
          ? formatDate(timestampToDate(child.updateTime))
          : undefined;

        entries.push({
          path: currentPath,
          title: child.name || '',
          docType,
          sourceUrl,
          lastUpdated: lastUpdated || undefined,
          platformId: fullPath,
        });
      }

      // 递归处理子节点
      if (Array.isArray(child.items) && child.items.length > 0) {
        this.collectLeafEntries(child.items, [...pathSegments, name], entries);
      }
    }
  }

  // ── fetchContent ──────────────────────────────────────────────────

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const fullPath = entry.platformId || '';
    if (!fullPath) {
      throw new Error(`[feishu] 文档缺少 platformId: ${entry.title}`);
    }

    const doc = await this.fetchMarkdown(fullPath);
    const aliasPath = this.aliasMap.get(fullPath) || '';
    const locale = detectLocale(fullPath, aliasPath, entry.title);

    const markdown = transformContent(doc.content || '', locale);
    const apiPath = extractApiPath(markdown);
    const eventName = extractEventName(markdown);

    const metadata: Record<string, unknown> = {};
    if (doc.updateTime) {
      const d = timestampToDate(doc.updateTime);
      if (d) metadata.last_updated = formatDate(d);
      metadata.update_timestamp = doc.updateTime;
    }
    if (eventName) {
      metadata.event_name = eventName;
    }
    metadata.locale = locale;

    return {
      markdown,
      apiPath,
      metadata,
    };
  }

  // ── detectUpdates ─────────────────────────────────────────────────

  async detectUpdates(since: Date): Promise<DocEntry[]> {
    const catalog = await this.fetchCatalog();
    const sinceTs = since.getTime();

    // 需要逐个检查 updateTime，使用并发控制
    const queue = new PQueue({ concurrency: CONCURRENCY, intervalCap: 12, interval: 1000 });
    const updated: DocEntry[] = [];

    for (const entry of catalog) {
      queue.add(async () => {
        try {
          const fullPath = entry.platformId || '';
          if (!fullPath) return;

          const doc = await this.fetchMarkdown(fullPath);
          if (!doc.updateTime) return;

          const docDate = timestampToDate(doc.updateTime);
          if (docDate && docDate.getTime() >= sinceTs) {
            entry.lastUpdated = formatDate(docDate);
            updated.push(entry);
          }
        } catch {
          // 跳过获取失败的文档
        }
      });
    }

    await queue.onIdle();
    return updated;
  }

  // ── 私有方法：API 请求 ─────────────────────────────────────────────

  private async fetchDirectoryTree(): Promise<TreeNode[]> {
    const response = await this.http.get(DIRECTORY_URL);
    if (!response.data || response.data.code !== 0) {
      throw new Error(`[feishu] 目录接口返回异常: ${JSON.stringify(response.data)}`);
    }
    return response.data.data?.items || [];
  }

  private async fetchUriMap(): Promise<Map<string, string>> {
    const response = await this.http.get(URI_MAP_URL);
    if (!response.data || response.data.code !== 0) {
      throw new Error(`[feishu] URI 映射接口返回异常: ${JSON.stringify(response.data)}`);
    }
    const map = new Map<string, string>();
    const uriMap: Record<string, string> = response.data.data?.uriMap || {};
    for (const [source, alias] of Object.entries(uriMap)) {
      if (typeof source === 'string' && typeof alias === 'string') {
        map.set(source, alias);
      }
    }
    return map;
  }

  private async fetchMarkdown(fullPath: string, attempt = 1): Promise<DocumentResponse> {
    try {
      const response = await this.http.get(DOCUMENT_DETAIL_URL, {
        params: { fullPath },
      });
      if (!response.data || response.data.code !== 0) {
        throw new Error(`[feishu] 文档接口返回异常: ${JSON.stringify(response.data)}`);
      }
      const doc = response.data.data?.document;
      if (!doc || !doc.content) {
        throw new Error(`[feishu] 未获取到 Markdown 内容: ${fullPath}`);
      }
      return doc as DocumentResponse;
    } catch (error: unknown) {
      const axiosErr = error as { response?: { status?: number } };
      const status = axiosErr?.response?.status;
      const retriable = !status || status >= 500 || status === 429;
      if (attempt < RETRY_LIMIT && retriable) {
        await delay(RETRY_DELAY_MS * attempt);
        return this.fetchMarkdown(fullPath, attempt + 1);
      }
      throw error;
    }
  }
}
