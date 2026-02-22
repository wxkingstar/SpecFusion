import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { decode } from 'html-entities';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://opendocs.alipay.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms）— 支付宝对 API 调用有频率限制，过快会返回 HTML 拦截页 */
const REQUEST_DELAY = 500;

/** 被限流后的退避等待（ms） */
const RATE_LIMIT_BACKOFF = 10_000;

/** 被限流后最大重试次数 */
const MAX_RETRIES = 3;

/**
 * 我们只抓取 "open" 站点（开放平台 API 文档）。
 * 支付宝文档中心还有 mini、isv、common 等站点，暂不纳入。
 *
 * 每个站点下有多个 repo（产品/功能分组），需逐个发现。
 * 发现方式：从 sitemap 抽取所有 catalogCode，调一次 content API 获取 repoCode。
 */
const TARGET_SITE = 'open';

// ─── API response interfaces ────────────────────────────────────────────────

interface AlipayContentResponse {
  success: boolean;
  traceId?: string;
  result: AlipayContentResult | null;
  breadCrumbs?: AlipayBreadCrumbs | null;
  errorContext?: unknown;
}

interface AlipayContentResult {
  contentCode: string;
  title: string;
  linkTitle: string | null;
  text: string; // HTML content (yuque/lake editor format)
  larkRawText?: string;
  tntInstId: string; // site name, e.g. "open"
  spaceCode: string;
  repoCode: string;
  catalogCode: string;
  gmtCreate: string;
  gmtModified: string;
  docType: { name: string };
  catalog: AlipayCatalogInfo;
  editorType?: string; // "yuque" etc.
}

interface AlipayCatalogInfo {
  catalogCode: string;
  catalogName: string;
  parentCatalogCode: string;
  hasPublishedContent: boolean;
  keywords?: string;
  repoCode?: string;
  extendLabels?: Record<string, string>;
}

interface AlipayBreadCrumbs {
  spaceCode: string;
  spaceName: string;
  repoCode: string;
  repoName: string;
  catalogCode: string;
  catalogName: string;
}

interface AlipayCatalogNode {
  catalogCode: string;
  catalogName: string;
  catalogType: { name: string }; // "FOLDER" or "FILE"
  childrenCatalog: AlipayCatalogNode[];
  hasPublishedContent: boolean;
  contentHash?: string;
  gmtModified?: string;
  link?: string | null;
  docType?: { name: string };
  extendLabels?: Record<string, string>;
}

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── HTML → Markdown conversion ─────────────────────────────────────────────

/**
 * 支付宝文档使用语雀（Yuque/Lake）编辑器，HTML 结构特点：
 * - 使用 <div class="lake-content"> 作为根容器
 * - 段落使用 <p class="ne-p">
 * - 代码块使用 <pre class="ne-codeblock"> 或 <div data-card-type="block" data-card-name="codeblock">
 * - 表格可能是标准 <table> 或嵌套 card 结构
 * - 行内代码使用 <code class="ne-code">
 */
function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';

  const $: CheerioAPI = load(html);

  // Convert code blocks (yuque style)
  $('pre').each((_, el) => {
    const $el = $(el);
    const code = $el.find('code');
    const lang = code.attr('class')?.replace(/^language-/, '').replace(/^ne-codeblock-/, '') || '';
    const text = decode(code.length ? code.text() : $el.text());
    $el.replaceWith(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`);
  });

  // Convert inline code
  $('code').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(`\`${text}\``);
    }
  });

  // Convert headings
  for (let i = 1; i <= 6; i++) {
    $(`h${i}`).each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (text) {
        $el.replaceWith(`\n${'#'.repeat(i)} ${text}\n`);
      }
    });
  }

  // Convert links
  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const text = $el.text().trim();
    if (text && href && !href.startsWith('javascript:')) {
      const fullHref = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      $el.replaceWith(`[${text}](${fullHref})`);
    } else if (text) {
      $el.replaceWith(text);
    }
  });

  // Convert images
  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || '';
    const alt = $el.attr('alt') || '';
    if (src) {
      $el.replaceWith(`![${alt}](${src})`);
    }
  });

  // Convert tables
  $('table').each((_, table) => {
    const $table = $(table);
    const rows: string[][] = [];
    let maxCols = 0;

    $table.find('tr').each((_, tr) => {
      const cells: string[] = [];
      $(tr)
        .find('th, td')
        .each((_, cell) => {
          cells.push($(cell).text().trim().replace(/\n/g, ' '));
        });
      if (cells.length > maxCols) maxCols = cells.length;
      rows.push(cells);
    });

    if (rows.length === 0) return;

    const lines: string[] = [];

    // First row as header
    const header = rows[0];
    while (header.length < maxCols) header.push('');
    lines.push(`| ${header.map(escapeCell).join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);

    // Data rows
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < maxCols) row.push('');
      lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
    }

    $table.replaceWith(`\n${lines.join('\n')}\n`);
  });

  // Convert lists
  $('ul, ol').each((_, list) => {
    const $list = $(list);
    const isOrdered = list.tagName === 'ol';
    const items: string[] = [];
    $list.children('li').each((idx, li) => {
      const prefix = isOrdered ? `${idx + 1}. ` : '- ';
      items.push(`${prefix}${$(li).text().trim()}`);
    });
    $list.replaceWith(`\n${items.join('\n')}\n`);
  });

  // Convert <br> to newline
  $('br').replaceWith('\n');

  // Convert <p> to paragraphs
  $('p').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(`\n${$el.html()}\n`);
    }
  });

  // Convert bold/strong
  $('strong, b').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(`**${text}**`);
    }
  });

  // Convert italic/em
  $('em, i').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(`*${text}*`);
    }
  });

  // Get the final text
  let md = decode($.root().text());

  // Clean up
  md = stripHtmlComments(md);
  md = md.replace(/<[^>]+>/g, ''); // strip remaining tags
  md = collapseBlankLines(md);
  md = md.trim();

  return md;
}

// ─── AlipaySource class ─────────────────────────────────────────────────────

export class AlipaySource implements DocSource {
  id = 'alipay';
  name = '支付宝开放平台';

  private client: AxiosInstance;
  private requestCount = 0;
  /** repoCode → repoName (面包屑中的产品名) */
  private repoNameMap = new Map<string, string>();

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${BASE_URL}/open/`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[alipay] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  /** 获取 sitemap 中所有 open 站点的文档 catalogCode */
  private async fetchSitemapCodes(): Promise<string[]> {
    console.log('[alipay] 获取 sitemap...');
    const resp = await this.client.get('/sitemap.xml', {
      headers: { Accept: 'text/xml' },
      timeout: 60_000,
    });
    const $ = load(resp.data, { xmlMode: true });
    const codes: string[] = [];
    $('url loc').each((_, el) => {
      const url = $(el).text().trim();
      // 只取 /open/{code} 格式（6 位字母数字 code）
      const match = url.match(new RegExp(`/${TARGET_SITE}/([a-z0-9]{5,8})$`));
      if (match) {
        codes.push(match[1]);
      }
    });
    // 去重
    return [...new Set(codes)];
  }

  /** 获取指定 repo 的完整目录树（含限流重试） */
  private async fetchCatalogTree(repoCode: string): Promise<AlipayCatalogNode | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle();
      try {
        const resp = await this.client.get(`/api/catalog/${repoCode}`, {
          params: { repoCode },
          transformResponse: [(data: string) => data],
        });

        const raw = resp.data as string;
        if (typeof raw === 'string' && (raw.trimStart().startsWith('<!DOCTYPE') || raw.trimStart().startsWith('<html'))) {
          if (attempt < MAX_RETRIES) {
            const wait = RATE_LIMIT_BACKOFF * (attempt + 1);
            console.warn(`[alipay] catalog 被限流，等待 ${wait / 1000}s 后重试...`);
            await delay(wait);
            continue;
          }
          return null;
        }

        const data = JSON.parse(raw) as AlipayCatalogNode;
        if (data && data.catalogCode) {
          return data;
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 获取单篇文档内容（含限流重试） */
  private async fetchDocContent(catalogCode: string): Promise<AlipayContentResponse> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle();
      const resp = await this.client.get(`/api/content/${catalogCode}`, {
        // 确保拿到原始文本，以便检测 HTML 拦截页
        transformResponse: [(data: string) => data],
      });

      const raw = resp.data as string;

      // 检测限流拦截页（返回 HTML 而非 JSON）
      if (typeof raw === 'string' && (raw.trimStart().startsWith('<!DOCTYPE') || raw.trimStart().startsWith('<html'))) {
        if (attempt < MAX_RETRIES) {
          const wait = RATE_LIMIT_BACKOFF * (attempt + 1);
          console.warn(`[alipay] 被限流，等待 ${wait / 1000}s 后重试 (${attempt + 1}/${MAX_RETRIES})...`);
          await delay(wait);
          continue;
        }
        throw new Error(`被限流，${MAX_RETRIES} 次重试后仍失败`);
      }

      return JSON.parse(raw) as AlipayContentResponse;
    }

    // 不应到达此处
    throw new Error('fetchDocContent: 超出重试次数');
  }

  // ─── Catalog tree traversal ────────────────────────────────────────────

  /** 从目录树中提取所有已发布的文件节点 */
  private extractEntries(
    node: AlipayCatalogNode,
    repoCode: string,
    repoName: string,
    parentPath: string = '',
  ): DocEntry[] {
    const entries: DocEntry[] = [];
    const currentPath = parentPath
      ? `${parentPath}/${node.catalogName}`
      : node.catalogName;

    if (
      node.catalogType.name === 'FILE' &&
      node.hasPublishedContent &&
      !node.link // 跳过外链
    ) {
      entries.push({
        path: `${repoName}/${currentPath}`,
        title: node.catalogName,
        docType: node.docType?.name === 'DOC_API' ? 'api_reference' : 'guide',
        sourceUrl: `${BASE_URL}/${TARGET_SITE}/${node.catalogCode}`,
        platformId: node.catalogCode,
        lastUpdated: node.gmtModified
          ? new Date(node.gmtModified).toISOString().split('T')[0]
          : undefined,
      });
    }

    for (const child of node.childrenCatalog || []) {
      entries.push(
        ...this.extractEntries(child, repoCode, repoName, currentPath),
      );
    }

    return entries;
  }

  // ─── Discover all repoCodes ────────────────────────────────────────────

  /**
   * 从 sitemap 中采样文档来发现所有 repoCode。
   * 策略：取前 N 个 code，调 content API 获取 repoCode，收集去重后的值。
   * 然后用 catalog tree API 获取每个 repo 的完整目录。
   */
  private async discoverRepoCodes(sitemapCodes: string[]): Promise<string[]> {
    const repoCodes = new Set<string>();
    const sampleSize = Math.min(sitemapCodes.length, 200);
    // 均匀采样
    const step = Math.max(1, Math.floor(sitemapCodes.length / sampleSize));
    const samples = sitemapCodes.filter((_, i) => i % step === 0).slice(0, sampleSize);

    console.log(`[alipay] 采样 ${samples.length} 个文档以发现 repoCode...`);

    for (const code of samples) {
      try {
        const resp = await this.fetchDocContent(code);
        if (resp.success && resp.result) {
          const repoCode = resp.result.repoCode;
          if (repoCode && !repoCodes.has(repoCode)) {
            repoCodes.add(repoCode);
            const repoName = resp.breadCrumbs?.repoName || resp.result.title;
            this.repoNameMap.set(repoCode, repoName);
            console.log(`[alipay] 发现 repo: ${repoCode} (${repoName})`);
          }
        }
      } catch {
        // 跳过失败的采样
      }
    }

    return [...repoCodes];
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    // Step 1: 从 sitemap 获取所有文档 code
    const sitemapCodes = await this.fetchSitemapCodes();
    console.log(`[alipay] sitemap 中发现 ${sitemapCodes.length} 个 ${TARGET_SITE} 文档 code`);

    // Step 2: 采样发现所有 repoCode
    const repoCodes = await this.discoverRepoCodes(sitemapCodes);
    console.log(`[alipay] 发现 ${repoCodes.length} 个 repo`);

    // Step 3: 用 catalog tree API 获取每个 repo 的完整目录
    const entries: DocEntry[] = [];
    const seenCodes = new Set<string>();

    for (const repoCode of repoCodes) {
      try {
        const tree = await this.fetchCatalogTree(repoCode);
        if (!tree) {
          console.warn(`[alipay] repo ${repoCode} 目录树获取失败，跳过`);
          continue;
        }
        const repoName = this.repoNameMap.get(repoCode) || tree.catalogName;
        const repoEntries = this.extractEntries(tree, repoCode, repoName);

        // 去重（多个 repo 可能有交叉引用）
        for (const entry of repoEntries) {
          if (entry.platformId && !seenCodes.has(entry.platformId)) {
            seenCodes.add(entry.platformId);
            entries.push(entry);
          }
        }

        console.log(
          `[alipay] repo ${repoName} (${repoCode}): ${repoEntries.length} 篇文档`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[alipay] 获取 repo ${repoCode} 目录树失败: ${msg}`);
      }
    }

    // sitemap 中有但 catalog tree 中缺失的文档不再补充——
    // 这些 code 大多已下线或无法通过 content API 获取，补充会导致大量无效请求。
    const sitemapOnly = sitemapCodes.filter((c) => !seenCodes.has(c)).length;
    if (sitemapOnly > 0) {
      console.log(`[alipay] sitemap 中有 ${sitemapOnly} 篇文档不在 catalog tree 中（已跳过）`);
    }

    console.log(`[alipay] 目录加载完成: ${repoCodes.length} 个 repo, ${entries.length} 篇文档`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const catalogCode = entry.platformId;
    if (!catalogCode) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    const resp = await this.fetchDocContent(catalogCode);
    if (!resp.success || !resp.result) {
      throw new Error(
        `获取文档 ${catalogCode} 内容失败: ${JSON.stringify(resp.errorContext || 'unknown')}`,
      );
    }

    const result = resp.result;

    // Build Markdown from content
    const sections: string[] = [];

    // Title
    const title = result.title || result.catalog?.catalogName || entry.title;
    sections.push(`# ${title}\n`);

    // Breadcrumb / category
    if (resp.breadCrumbs?.repoName) {
      sections.push(`产品：${resp.breadCrumbs.repoName}\n`);
    }

    // Keywords
    if (result.catalog?.keywords) {
      sections.push(`关键词：${result.catalog.keywords}\n`);
    }

    // Main content (HTML → Markdown)
    if (result.text) {
      const md = htmlToMarkdown(result.text);
      if (md) {
        sections.push(md);
      }
    }

    const markdown = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Tokenize for FTS
    const tokenizedTitle = tokenize(title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (result.gmtModified) {
      const date = new Date(result.gmtModified);
      if (!isNaN(date.getTime())) {
        metadata.lastUpdated = date.toISOString().split('T')[0];
      }
    }

    return {
      markdown,
      apiPath: title,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
