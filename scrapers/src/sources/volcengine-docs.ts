import axios, { type AxiosInstance } from 'axios';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** 文档 JSON 接口所在域名 */
const BASE_URL = 'https://www.volcengine.com';
/** 文档站页面域名（www.volcengine.com/docs/* 已整体 301 到这里） */
const DOCS_SITE_URL = 'https://docs.volcengine.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** catalog 阶段请求间隔（获取产品树，响应较大） */
const CATALOG_DELAY = 800;
/** content 阶段请求间隔 */
const CONTENT_DELAY = 500;

// ─── 文档中心接口结构 ────────────────────────────────────────────────────────
// 文档站已整体迁到 docs.volcengine.com 的客户端渲染应用（@volc-intelligent/doccenter），
// 页面不再内嵌 window._ROUTER_DATA。产品列表、目录树、正文全部来自以下公开 JSON 接口，
// 且不受站点 WAF 反爬挑战影响：
//   产品列表：GET /api/doc/getLibList?type=online
//   目录树：  GET /api/doc/getDocList?LibraryID={libId}&DataSchema=all_second_nav&type=online
//   正文：    GET /api/doc/getDocDetail?LibraryID={libId}&DocumentID={docId}&type=online

/** getLibList 产品文档库 */
interface LibraryItem {
  LibraryID: number;
  Name: string;
  CategoryName: string;
  Status: number; // 2 = published, 5 = offline
  /** 1 = 官网营销内容库（资讯、报告、活动页等），不是产品文档 */
  IsOfficialWebsiteContentCategory: number;
}

interface Product {
  libId: number;
  name: string;
  category: string;
}

/** getDocDetail Result */
interface DocDetail {
  DocumentID: number;
  LibraryID: number;
  Title: string;
  MDContent: string;
  Content: string;
  ContentType: string;
  UpdatedTime?: string;
}

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
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 60_000,
      maxRedirects: 5,
      // 大产品的目录树 / 长文档正文可达数百 KB
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
   * 获取产品列表：只保留已发布的产品文档库，排除官网营销内容库。
   * 该口径与旧版文档中心首页的产品列表一致。
   */
  private async fetchProducts(): Promise<Product[]> {
    await this.throttle(CATALOG_DELAY);
    const resp = await this.client.get('/api/doc/getLibList', { params: { type: 'online' } });
    const libs = resp.data?.Result as LibraryItem[] | undefined;
    if (!Array.isArray(libs) || libs.length === 0) {
      throw new Error('getLibList 返回异常：产品列表为空');
    }
    return libs
      .filter((lib) => lib.Status === 2 && lib.IsOfficialWebsiteContentCategory !== 1)
      .map((lib) => ({ libId: lib.LibraryID, name: lib.Name, category: lib.CategoryName }));
  }

  /** 获取产品完整目录树（按二级导航分组的扁平节点） */
  private async fetchDocList(libId: number): Promise<DocListResult> {
    await this.throttle(CATALOG_DELAY);
    const resp = await this.client.get('/api/doc/getDocList', {
      params: { LibraryID: libId, DataSchema: 'all_second_nav', type: 'online' },
    });
    const result = resp.data?.Result;
    if (!result || typeof result !== 'object') {
      throw new Error(`getDocList 返回异常 (LibID=${libId})`);
    }
    return result as DocListResult;
  }

  /** 获取单篇文档正文（含 MDContent） */
  private async fetchDocDetail(libId: number, docId: number): Promise<DocDetail | null> {
    await this.throttle(CONTENT_DELAY);
    const resp = await this.client.get('/api/doc/getDocDetail', {
      params: { LibraryID: libId, DocumentID: docId, AuditDocumentID: '', type: 'online' },
    });
    const result = resp.data?.Result;
    return result && typeof result === 'object' ? (result as DocDetail) : null;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[volcengine] 获取产品列表...');
    const products = await this.fetchProducts();
    const categoryCount = new Set(products.map((p) => p.category)).size;
    console.log(`[volcengine] 发现 ${categoryCount} 个分类, ${products.length} 个产品`);

    const entries: DocEntry[] = [];
    let productIndex = 0;

    for (const product of products) {
      productIndex++;
      try {
        const result = await this.fetchDocList(product.libId);
        const productEntries = this.entriesFromDocList(result, product);
        entries.push(...productEntries);
        console.log(
          `[volcengine] (${productIndex}/${products.length}) ${product.name} (LibID=${product.libId}): ${productEntries.length} 篇文档`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[volcengine] ✗ ${product.name} (LibID=${product.libId}) 失败: ${msg}`);
      }
    }

    console.log(`[volcengine] 目录加载完成: ${products.length} 个产品, ${entries.length} 篇文档`);
    return entries;
  }

  /** getDocList → DocEntry[]（按 SecondNav 分组，沿 ParentID 上溯构建路径；Type=0, Status=2 为已发布文档） */
  private entriesFromDocList(result: DocListResult, product: Product): DocEntry[] {
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
          sourceUrl: `${DOCS_SITE_URL}/docs/${product.libId}/${n.DocumentID}`,
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

    const doc = await this.fetchDocDetail(libId, docId);
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
