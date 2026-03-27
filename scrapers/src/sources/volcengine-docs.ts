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

  /** 获取文档中心首页的产品分类列表 */
  private async fetchCategoryList(): Promise<CategoryItem[]> {
    const resp = await this.client.get('/docs');
    const data = extractRouterData(resp.data);
    if (!data) throw new Error('无法解析文档中心首页 _ROUTER_DATA');

    const pageData = getLoaderData(data, 'docs/page');
    if (!pageData) throw new Error('无法获取 docs/page loaderData');

    return pageData.categoryList as CategoryItem[];
  }

  /** 获取单个产品的文档树（nodeMap） */
  private async fetchProductTree(libId: number): Promise<Record<string, TreeNode>> {
    await this.throttle(CATALOG_DELAY);
    const resp = await this.client.get(`/docs/${libId}`, { params: { lang: 'zh' } });
    const data = extractRouterData(resp.data);
    if (!data) throw new Error(`无法解析产品 ${libId} 页面`);

    const pageData = getLoaderData(data, 'docs/(libid)/(docid$)/page');
    if (!pageData?.nodeMap) {
      throw new Error(`产品 ${libId} 无 nodeMap`);
    }

    return pageData.nodeMap as Record<string, TreeNode>;
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
        const nodeMap = await this.fetchProductTree(product.libId);
        const nodeCount = Object.keys(nodeMap).length - 1; // exclude root '0'

        // 提取所有已发布的文档节点（Type=0, Status=2）
        let docCount = 0;
        for (const [nodeId, node] of Object.entries(nodeMap)) {
          if (nodeId === '0') continue;
          const val = node.value;
          if (!val) continue;
          // Type 0 = document page, Status 2 = published
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
          docCount++;
        }

        console.log(
          `[volcengine] (${productIndex}/${products.length}) ${product.name} (LibID=${product.libId}): ${nodeCount} 节点, ${docCount} 篇文档`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[volcengine] ✗ ${product.name} (LibID=${product.libId}) 失败: ${msg}`);
      }
    }

    console.log(`[volcengine] 目录加载完成: ${products.length} 个产品, ${entries.length} 篇文档`);
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

    const doc = await this.fetchDocContent(libId, docId);
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
