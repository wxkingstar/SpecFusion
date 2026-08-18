import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { decode } from 'html-entities';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://help.aliyun.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms）— 阿里云帮助中心有 x5sec 反爬，需要较长间隔 */
const REQUEST_DELAY = 1500;

/** 被限流后的退避等待（ms） */
const RATE_LIMIT_BACKOFF = 15_000;

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 每 N 个请求后额外休息，避免触发反爬 */
const BATCH_REST_INTERVAL = 50;
const BATCH_REST_DURATION = 30_000;

/** 单次请求超时 */
const REQUEST_TIMEOUT = 30_000;

/** 阿里云百炼在帮助中心的根别名 */
const PRODUCT_ALIAS = '/model-studio';

/**
 * 4 个 Tab 对应的 alias —— 用于 menupath.json 请求参数中的
 * "alias" 字段。任何一个文档的 alias 都能返回完整菜单树，
 * 这里只需要一个种子即可。
 */
const SEED_ALIAS = '/model-studio/what-is-model-studio';

// ─── Menu API interfaces ────────────────────────────────────────────────────

interface MenuNode {
  id: number;
  title: string;
  alias: string;
  nodeType: number; // 1 = document, 8 = folder/category
  level: number;
  children?: MenuNode[];
  url?: string;
  emptyNode?: boolean;
  validDocument?: boolean;
}

interface MenuPathResponse {
  code: number;
  success: boolean;
  data: MenuNode;
}

// ─── Utility helpers ────────────────────────────────────────────────────────


function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── HTML → Markdown conversion ─────────────────────────────────────────────

/**
 * 阿里云帮助中心 HTML 结构特点：
 * - 内容在 <main id="main-{docId}"> 中
 * - 使用 ICMS 编辑器格式
 * - 代码块使用 <pre> + <code>
 * - 标签式代码块使用 <section class="tabbed-content-box">
 * - 表格使用标准 <table>，但 header 行可能不在 <thead> 中
 * - 提示框使用 <div class="note note-note"> 等
 */
function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';

  const $: CheerioAPI = load(html);

  // Remove script/style tags
  $('script, style, svg, .help-letter-space').remove();

  // Convert note/warning/important boxes
  $('div.note').each((_, el) => {
    const $el = $(el);
    const noteType = $el.hasClass('note-warning')
      ? '**警告**'
      : $el.hasClass('note-important')
        ? '**重要**'
        : $el.hasClass('note-tip')
          ? '**提示**'
          : '**说明**';
    const content = $el.find('.noteContentSpan').text().trim();
    if (content) {
      $el.replaceWith(`\n> ${noteType} ${content}\n`);
    }
  });

  // Convert code blocks
  $('pre').each((_, el) => {
    const $el = $(el);
    const code = $el.find('code');
    const langClass = code.attr('class') || $el.attr('class') || '';
    const lang = langClass.match(/language-(\w+)/)?.[1] || '';
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
    if (src && !src.startsWith('data:')) {
      $el.replaceWith(`![${alt}](${src})`);
    } else {
      $el.remove();
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
    const header = rows[0];
    while (header.length < maxCols) header.push('');
    lines.push(`| ${header.map(escapeCell).join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);

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
    const inner = $el.html();
    if (inner && inner.trim()) {
      $el.replaceWith(`\n${inner}\n`);
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

// ─── Extract API path from content ──────────────────────────────────────────

/** 从 Markdown 内容中提取 HTTP API 路径 */
function extractApiPath(markdown: string): string | undefined {
  // Match patterns like: POST https://dashscope.aliyuncs.com/api/v1/services/...
  const httpMatch = markdown.match(
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/[^\s)}\]"'`]+)/i,
  );
  if (httpMatch) {
    try {
      const url = new URL(httpMatch[1]);
      return url.pathname;
    } catch {
      // ignore
    }
  }

  // Match patterns like: /api/v1/...
  const pathMatch = markdown.match(
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9/_-]+)/i,
  );
  if (pathMatch) {
    return pathMatch[1];
  }

  return undefined;
}

/** 从内容中提取错误码 */
function extractErrorCodes(
  markdown: string,
): Array<{ code: string; message?: string; description?: string }> | undefined {
  const codes: Array<{ code: string; message?: string; description?: string }> = [];
  // Match table rows with error codes: | code | message | description |
  const tableRowRegex = /\|\s*(\d{3,6})\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;
  let match;
  while ((match = tableRowRegex.exec(markdown)) !== null) {
    codes.push({
      code: match[1].trim(),
      message: match[2].trim() || undefined,
      description: match[3].trim() || undefined,
    });
  }
  return codes.length > 0 ? codes : undefined;
}

// ─── BailianSource class ────────────────────────────────────────────────────

export class BailianSource implements DocSource {
  id = 'bailian';
  name = '阿里云百炼';

  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        Referer: `${BASE_URL}/zh/model-studio/`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      maxContentLength: 10 * 1024 * 1024,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(ms: number = REQUEST_DELAY): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[bailian] 已发送 ${this.requestCount} 个请求`);
    }
    // 每 N 个请求额外休息一段时间
    if (this.requestCount % BATCH_REST_INTERVAL === 0) {
      console.log(
        `[bailian] 批次休息 ${BATCH_REST_DURATION / 1000}s (已发送 ${this.requestCount} 个请求)`,
      );
      await delay(BATCH_REST_DURATION);
    }
    // 基础延迟 + 随机 jitter（0~50% 的基础延迟）
    const jitter = Math.floor(Math.random() * ms * 0.5);
    await delay(ms + jitter);
  }

  /** 检测响应是否为 x5sec 反爬拦截页 */
  private isAntiBot(html: string): boolean {
    if (typeof html !== 'string') return false;
    return (
      html.includes('x5secdata=') ||
      html.includes('_____tmd_____') ||
      html.includes('rgv587_flag') ||
      (html.length < 5000 && html.includes('punish'))
    );
  }

  // ─── Menu tree API ─────────────────────────────────────────────────────

  /**
   * 获取完整文档目录树（含反爬重试）。
   * 阿里云帮助中心提供 menupath.json API，传入任意一个文档的 alias 即可
   * 返回该产品的完整菜单树。
   */
  private async fetchMenuTree(): Promise<MenuNode> {
    console.log('[bailian] 获取文档目录树...');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const wait = RATE_LIMIT_BACKOFF * attempt;
        console.warn(`[bailian] 目录获取重试 ${attempt}/${MAX_RETRIES}，等待 ${wait / 1000}s...`);
        await delay(wait);
      }

      const resp = await this.client.get('/help/json/menupath.json', {
        params: {
          alias: SEED_ALIAS,
          website: 'cn',
          language: 'zh',
          channel: '',
        },
        transformResponse: [(data: string) => data],
      });

      const raw = resp.data as string;

      // 检测反爬拦截
      if (this.isAntiBot(raw)) {
        if (attempt < MAX_RETRIES) continue;
        throw new Error('menupath.json 被反爬拦截，重试后仍失败');
      }

      const data = JSON.parse(raw) as MenuPathResponse;
      if (!data.success || !data.data) {
        throw new Error('menupath.json 返回失败');
      }

      return data.data;
    }

    throw new Error('fetchMenuTree: 超出重试次数');
  }

  // ─── Tree traversal ────────────────────────────────────────────────────

  /**
   * 递归遍历菜单树，提取所有文档节点（nodeType=1）
   */
  private extractEntries(
    node: MenuNode,
    parentPath: string = '',
  ): DocEntry[] {
    const entries: DocEntry[] = [];

    // 构建当前路径
    const currentPath = parentPath
      ? `${parentPath}/${node.title}`
      : node.title;

    // nodeType=1 表示文档页面
    if (node.nodeType === 1 && node.alias) {
      // 判断文档类型
      let docType: string = 'guide';
      const pathLower = currentPath.toLowerCase();
      if (
        pathLower.includes('api参考') ||
        pathLower.includes('api reference')
      ) {
        docType = 'api_reference';
      } else if (pathLower.includes('错误码') || pathLower.includes('error')) {
        docType = 'error_code';
      }

      entries.push({
        path: currentPath,
        title: node.title,
        docType,
        sourceUrl: `${BASE_URL}/zh${node.alias}`,
        platformId: String(node.id),
      });
    }

    // 递归处理子节点
    if (node.children) {
      for (const child of node.children) {
        entries.push(...this.extractEntries(child, currentPath));
      }
    }

    return entries;
  }

  // ─── Content fetching ──────────────────────────────────────────────────

  /**
   * 获取单篇文档的 HTML 内容（含反爬重试）。
   * 直接请求 help.aliyun.com/zh{alias}，内容在 <main> 标签中。
   */
  private async fetchDocHtml(alias: string): Promise<string> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle();
      const resp = await this.client.get(`/zh${alias}`, {
        headers: { Accept: 'text/html' },
        // 拿到原始文本以便检测反爬页
        transformResponse: [(data: string) => data],
      });

      const html = resp.data as string;

      if (this.isAntiBot(html)) {
        if (attempt < MAX_RETRIES) {
          const wait = RATE_LIMIT_BACKOFF * (attempt + 1);
          console.warn(
            `[bailian] x5sec 反爬拦截，等待 ${wait / 1000}s 后重试 (${attempt + 1}/${MAX_RETRIES})...`,
          );
          await delay(wait);
          continue;
        }
        throw new Error(`被反爬拦截，${MAX_RETRIES} 次重试后仍失败: ${alias}`);
      }

      return html;
    }

    throw new Error(`fetchDocHtml: 超出重试次数: ${alias}`);
  }

  /**
   * 从 HTML 中提取 <main> 标签内的内容
   */
  private extractMainContent(html: string): string {
    // 快速定位 <main> 标签
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
    if (mainMatch) {
      return mainMatch[1];
    }

    // 降级：尝试定位 icms-help-docs-content
    const contentMatch = html.match(
      /<div[^>]*class="icms-help-docs-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/,
    );
    if (contentMatch) {
      return contentMatch[1];
    }

    return '';
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    const rootNode = await this.fetchMenuTree();

    // 跳过根节点（大模型服务平台百炼），直接从 4 个 Tab 开始构建路径
    const entries: DocEntry[] = [];
    const tabs = rootNode.children || [];

    for (const tab of tabs) {
      const tabEntries = this.extractEntries(tab);
      entries.push(...tabEntries);
      console.log(`[bailian] ${tab.title}: ${tabEntries.length} 篇文档`);
    }

    console.log(`[bailian] 目录加载完成: ${entries.length} 篇文档`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    // 从 sourceUrl 中提取 alias
    const alias = entry.sourceUrl
      ? entry.sourceUrl.replace(`${BASE_URL}/zh`, '')
      : `${PRODUCT_ALIAS}/${entry.platformId}`;

    const html = await this.fetchDocHtml(alias);
    const mainHtml = this.extractMainContent(html);

    if (!mainHtml) {
      throw new Error(`无法提取文档内容: ${entry.title} (alias=${alias})`);
    }

    // 转换为 Markdown
    let markdown = htmlToMarkdown(mainHtml);

    // 添加标题
    if (markdown && !markdown.startsWith('# ')) {
      markdown = `# ${entry.title}\n\n${markdown}`;
    }

    // 提取 API 路径
    const apiPath = extractApiPath(markdown);

    // 提取错误码
    const errorCodes = extractErrorCodes(markdown);

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    return {
      markdown,
      apiPath,
      errorCodes,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
