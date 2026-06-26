import axios, { type AxiosInstance } from 'axios';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.volcengine.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** catalog 阶段请求间隔（获取产品树，页面较大） */
const CATALOG_DELAY = 800;
/** content 阶段请求间隔 */
const CONTENT_DELAY = 500;

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface CategoryItem {
  title: string;
  category: string;
  categoryID: string;
  items: ProductItem[];
}

interface ProductItem {
  title: string;
  description: string;
  href: string; // e.g., "/docs/6396"
}

/** nodeMap 中的节点 */
interface TreeNode {
  value?: {
    DocumentID: number;
    Title: string;
    ParentID: number;
    LibraryID: number;
    Type: number;      // 0 = document, 1 = folder
    Status: number;     // 2 = published, 5 = hidden
    ContentType: string;
    Index: number;
    UpdatedTime?: string;
  };
  children?: number[];
}

interface CurDoc {
  DocumentID: number;
  LibraryID: number;
  Title: string;
  MDContent: string;
  Content: string;
  ContentType: string;
  UpdatedTime?: string;
}

// ─── 新文档中心（Garfish 微前端 @volc-intelligent/doccenter）接口结构 ──────────
// 已迁移产品页不再内嵌 window._ROUTER_DATA，目录树/正文改由以下 JSON 接口提供：
//   目录树：GET /api/doc/getDocList?LibraryID={libId}&DataSchema=all_second_nav&type=online
//   正文：  GET /api/doc/getDocDetail?LibraryID={libId}&DocumentID={docId}&type=online
// 这两个接口对所有产品通用，且不受站点 WAF 反爬挑战影响，用作迁移产品的抓取路径。

/** getDocList 扁平节点 */
interface DocListNode {
  DocumentID: number;
  Title: string;
  ParentID: number;
  Type: number;    // 0 = document, 1 = folder/nav
  Status: number;  // 2 = published
  ContentType?: string;
  Index?: number;
  Language?: string;
  DocumentCode?: string;
  /** 仅顶层节点携带，标识所属二级导航分组 */
  SecondNav?: { ID: number; Name: string } | null;
  Childrens?: unknown;
}

/** getDocList Result：按二级导航(SecondNav) ID 分组的扁平节点数组 */
type DocListResult = Record<string, DocListNode[]>;

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 从 HTML 中提取 _ROUTER_DATA JSON */
function extractRouterData(html: string): Record<string, unknown> | null {
  const start = html.indexOf('window._ROUTER_DATA');
  if (start < 0) return null;

  const end = html.indexOf('</script>', start);
  if (end < 0) return null;

  const chunk = html.substring(start, end);
  const jsonStart = chunk.indexOf('{');
  if (jsonStart < 0) return null;

  let raw = chunk.substring(jsonStart);
  if (raw.endsWith(';')) raw = raw.slice(0, -1);

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从 loaderData 中获取指定 key 的值（key 中 / 编码为 unicode） */
function getLoaderData(routerData: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const loaderData = routerData.loaderData as Record<string, unknown> | undefined;
  if (!loaderData) return null;

  // Try both raw key and unicode-escaped key
  const val = loaderData[key] ?? loaderData[key.replace(/\//g, '\u002F')];
  return (val && typeof val === 'object') ? val as Record<string, unknown> : null;
}

/** 构建节点的完整路径（从根到当前节点的 Title 拼接） */
function buildNodePath(
  nodeMap: Record<string, TreeNode>,
  nodeId: string,
  productName: string,
): string {
  const parts: string[] = [];
  let currentId = nodeId;
  const visited = new Set<string>();

  while (currentId && currentId !== '0' && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeMap[currentId];
    if (!node?.value) break;
    parts.unshift(node.value.Title);
    currentId = String(node.value.ParentID);
  }

  // 去掉最顶层（通常与产品名重复）
  if (parts.length > 1 && parts[0] === productName) {
    parts.shift();
  }

  return parts.join('/');
}

/** 从 getDocList 扁平节点构建路径：secondNavName/folder.../docTitle（沿 ParentID 上溯） */
function buildApiNodePath(
  byId: Map<number, DocListNode>,
  node: DocListNode,
  navName: string,
): string {
  const parts: string[] = [];
  let cur: DocListNode | undefined = node;
  const visited = new Set<number>();

  while (cur && !visited.has(cur.DocumentID)) {
    visited.add(cur.DocumentID);
    parts.unshift(cur.Title);
    if (cur.ParentID === 0) break;
    cur = byId.get(cur.ParentID);
  }

  // 顶层加上二级导航分组名（如「文档指南」「API参考」）
  if (navName) parts.unshift(navName);

  return parts.join('/');
}

// ─── VolcengineDocsSource class ─────────────────────────────────────────────

export class VolcengineDocsSource implements DocSource {
  id = 'volcengine';
  name = '火山引擎';

  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 60_000,
      maxRedirects: 5,
      // SSR pages can be 1-2.5MB
      maxContentLength: 10 * 1024 * 1024,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(ms: number): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[volcengine] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(ms);
  }

  // ─── Data fetching ─────────────────────────────────────────────────────

  /**
   * 获取文档中心首页的产品分类列表。
   * 首页已迁移为客户端渲染，SSR(_ROUTER_DATA) 仅间歇性返回（夹杂客户端壳 / WAF 反爬挑战），
   * 故重试退避直到拿到含 categoryList 的 SSR 变体。
   */
  private async fetchCategoryList(): Promise<CategoryItem[]> {
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await this.client.get('/docs');
      const data = extractRouterData(resp.data);
      const pageData = data ? getLoaderData(data, 'docs/page') : null;
      const categoryList = pageData?.categoryList as CategoryItem[] | undefined;
      if (Array.isArray(categoryList) && categoryList.length > 0) {
        return categoryList;
      }
      if (attempt < maxAttempts) {
        console.log(`[volcengine] 首页未返回 SSR 目录数据，退避重试 ${attempt}/${maxAttempts}...`);
        await delay(2000);
      }
    }
    throw new Error('无法解析文档中心首页 _ROUTER_DATA（多次重试后仍失败）');
  }

  /**
   * 获取单个产品的文档树（旧 SSR 路径）。
   * 返回 nodeMap；若页面已迁移到新文档中心（无 _ROUTER_DATA / nodeMap）则返回 null，
   * 由调用方改走新版 getDocList API。
   */
  private async fetchProductTree(libId: number): Promise<Record<string, TreeNode> | null> {
    await this.throttle(CATALOG_DELAY);
    const resp = await this.client.get(`/docs/${libId}`, { params: { lang: 'zh' } });
    const data = extractRouterData(resp.data);
    if (!data) return null;

    const pageData = getLoaderData(data, 'docs/(libid)/(docid$)/page');
    if (!pageData?.nodeMap) return null;

    return pageData.nodeMap as Record<string, TreeNode>;
  }

  /** 新文档中心：获取产品完整目录树（按二级导航分组的扁平节点） */
  private async fetchDocListApi(libId: number): Promise<DocListResult> {
    await this.throttle(CATALOG_DELAY);
    const resp = await this.client.get('/api/doc/getDocList', {
      params: { LibraryID: libId, DataSchema: 'all_second_nav', type: 'online' },
      headers: { Accept: 'application/json' },
    });
    const result = resp.data?.Result;
    if (!result || typeof result !== 'object') {
      throw new Error(`getDocList 返回异常 (LibID=${libId})`);
    }
    return result as DocListResult;
  }

  /** 新文档中心：获取单篇文档正文（与 CurDoc 同 shape，含 MDContent） */
  private async fetchDocDetailApi(libId: number, docId: number): Promise<CurDoc | null> {
    await this.throttle(CONTENT_DELAY);
    const resp = await this.client.get('/api/doc/getDocDetail', {
      params: { LibraryID: libId, DocumentID: docId, AuditDocumentID: '', type: 'online' },
      headers: { Accept: 'application/json' },
    });
    const result = resp.data?.Result;
    return result && typeof result === 'object' ? (result as CurDoc) : null;
  }

  /** 获取单篇文档的 MDContent */
  private async fetchDocContent(libId: number, docId: number): Promise<CurDoc | null> {
    await this.throttle(CONTENT_DELAY);
    const resp = await this.client.get(`/docs/${libId}/${docId}`, { params: { lang: 'zh' } });
    const data = extractRouterData(resp.data);
    if (!data) return null;

    const pageData = getLoaderData(data, 'docs/(libid)/(docid$)/page');
    return (pageData?.curDoc as CurDoc) ?? null;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[volcengine] 获取产品分类列表...');
    const categories = await this.fetchCategoryList();

    // 收集所有产品
    const products: Array<{ libId: number; name: string; category: string }> = [];
    for (const cat of categories) {
      for (const item of cat.items) {
        const match = item.href.match(/\/docs\/(\d+)/);
        if (match) {
          products.push({
            libId: parseInt(match[1], 10),
            name: item.title,
            category: cat.title,
          });
        }
      }
    }
    console.log(`[volcengine] 发现 ${categories.length} 个分类, ${products.length} 个产品`);

    const entries: DocEntry[] = [];
    let productIndex = 0;

    for (const product of products) {
      productIndex++;
      try {
        // 旧 SSR 路径优先；迁移到新文档中心的产品（nodeMap 为 null）改走新版 API
        const nodeMap = await this.fetchProductTree(product.libId);
        let productEntries: DocEntry[];
        let via: string;
        if (nodeMap) {
          productEntries = this.entriesFromNodeMap(nodeMap, product);
          via = 'SSR';
        } else {
          const result = await this.fetchDocListApi(product.libId);
          productEntries = this.entriesFromDocList(result, product);
          via = 'API';
        }

        entries.push(...productEntries);
        console.log(
          `[volcengine] (${productIndex}/${products.length}) ${product.name} (LibID=${product.libId}) [${via}]: ${productEntries.length} 篇文档`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[volcengine] ✗ ${product.name} (LibID=${product.libId}) 失败: ${msg}`);
      }
    }

    console.log(`[volcengine] 目录加载完成: ${products.length} 个产品, ${entries.length} 篇文档`);
    return entries;
  }

  /** 旧 SSR nodeMap → DocEntry[]（Type=0, Status=2 为已发布文档） */
  private entriesFromNodeMap(
    nodeMap: Record<string, TreeNode>,
    product: { libId: number; name: string; category: string },
  ): DocEntry[] {
    const entries: DocEntry[] = [];
    for (const [nodeId, node] of Object.entries(nodeMap)) {
      if (nodeId === '0') continue;
      const val = node.value;
      if (!val) continue;
      if (val.Type !== 0 || val.Status !== 2) continue;

      const path = buildNodePath(nodeMap, nodeId, product.name);
      entries.push({
        path: `${product.category}/${product.name}/${path}`,
        title: val.Title,
        docType: 'guide',
        sourceUrl: `${BASE_URL}/docs/${product.libId}/${val.DocumentID}`,
        platformId: `${product.libId}:${val.DocumentID}`,
        lastUpdated: val.UpdatedTime
          ? new Date(val.UpdatedTime).toISOString().split('T')[0]
          : undefined,
      });
    }
    return entries;
  }

  /** 新文档中心 getDocList → DocEntry[]（按 SecondNav 分组，沿 ParentID 上溯构建路径） */
  private entriesFromDocList(
    result: DocListResult,
    product: { libId: number; name: string; category: string },
  ): DocEntry[] {
    const entries: DocEntry[] = [];
    for (const nodes of Object.values(result)) {
      if (!Array.isArray(nodes)) continue;

      const byId = new Map<number, DocListNode>();
      for (const n of nodes) byId.set(n.DocumentID, n);
      const navName = nodes.find((n) => n.SecondNav?.Name)?.SecondNav?.Name ?? '';

      for (const n of nodes) {
        if (n.Type !== 0 || n.Status !== 2) continue;
        const path = buildApiNodePath(byId, n, navName);
        entries.push({
          path: `${product.category}/${product.name}/${path}`,
          title: n.Title,
          docType: 'guide',
          sourceUrl: `${BASE_URL}/docs/${product.libId}/${n.DocumentID}`,
          platformId: `${product.libId}:${n.DocumentID}`,
        });
      }
    }
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const platformId = entry.platformId;
    if (!platformId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    const [libIdStr, docIdStr] = platformId.split(':');
    const libId = parseInt(libIdStr, 10);
    const docId = parseInt(docIdStr, 10);

    // 旧 SSR 路径优先；迁移产品页无 _ROUTER_DATA，回退到新版 getDocDetail API
    let doc = await this.fetchDocContent(libId, docId);
    if (!doc) {
      doc = await this.fetchDocDetailApi(libId, docId);
    }
    if (!doc) {
      throw new Error(`无法获取文档内容: ${entry.title} (${platformId})`);
    }

    let markdown = doc.MDContent || '';

    // 如果没有 MDContent，尝试从 Content (JSON rich-text) 中提取纯文本
    if (!markdown && doc.Content && doc.ContentType === 'json') {
      try {
        const contentData = JSON.parse(doc.Content) as {
          data?: Record<string, { ops?: Array<{ insert?: string | unknown }> }>;
        };
        const textParts: string[] = [];
        if (contentData.data) {
          for (const section of Object.values(contentData.data)) {
            if (section.ops) {
              for (const op of section.ops) {
                if (typeof op.insert === 'string' && op.insert.trim() && op.insert.trim() !== '*') {
                  textParts.push(op.insert);
                }
              }
            }
          }
        }
        markdown = textParts.join('');
      } catch {
        // Content 解析失败，跳过
      }
    }

    // 清理 markdown
    markdown = collapseBlankLines(markdown).trim();

    // 添加标题头
    if (markdown && !markdown.startsWith('# ')) {
      markdown = `# ${entry.title}\n\n${markdown}`;
    }

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (doc.UpdatedTime) {
      const date = new Date(doc.UpdatedTime);
      if (!isNaN(date.getTime())) {
        metadata.lastUpdated = date.toISOString().split('T')[0];
      }
    }

    return {
      markdown,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
