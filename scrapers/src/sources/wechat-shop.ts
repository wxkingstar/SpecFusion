import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { tokenize } from '../utils/tokenizer.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://developers.weixin.qq.com';
const CATALOG_URL = `${BASE_URL}/doc/store/shop/`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 请求间隔（ms）— 微信文档站较宽松 */
const BASE_DELAY = 500;
/** 请求间隔随机抖动范围（ms） */
const JITTER = 300;

/** 文档路径前缀，用于匹配和裁剪 */
const DOC_PATH_PREFIX = '/doc/store/shop/';

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function randomDelay(base: number, jitter: number): Promise<void> {
  const ms = base + Math.floor(Math.random() * jitter);
  return delay(ms);
}

// ─── HTML → Markdown conversion ─────────────────────────────────────────────

/**
 * 将微信文档 .content 区域的 HTML 转换为 Markdown。
 * 与 wechat-miniprogram 使用相同的转换逻辑（同域名同模板）。
 */
function contentHtmlToMarkdown(rawHtml: string): string {
  const $ = load(rawHtml);

  // 移除无用元素
  $('script, style, .header-anchor, .api-explorer').remove();

  // ── 代码块 ──────────────────────────────────────────────────────────

  $('div[class*="language-"]').each((_i, el) => {
    const $el = $(el);
    const classAttr = $el.attr('class') || '';
    const langMatch = classAttr.match(/language-(\w+)/);
    const lang = langMatch ? langMatch[1] : '';
    const codeEl = $el.find('pre code');
    const text = codeEl.length > 0 ? codeEl.text() : $el.find('pre').text();
    $el.replaceWith(`\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n`);
  });

  // 处理 pre > code（没有被上面捕获的）
  $('pre').each((_i, el) => {
    const $el = $(el);
    const codeEl = $el.find('code');
    const lang = codeEl.attr('class')?.match(/language-(\w+)/)?.[1] || '';
    const text = codeEl.length > 0 ? codeEl.text() : $el.text();
    $el.replaceWith(`\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n`);
  });

  // 内联 code
  $('code').each((_i, el) => {
    const $el = $(el);
    if ($el.parent().is('pre')) return;
    const text = $el.text().replace(/`/g, '\\`');
    $el.replaceWith(`\`${text}\``);
  });

  // ── 标题 ────────────────────────────────────────────────────────────

  for (let i = 1; i <= 6; i++) {
    $(`h${i}`).each((_j, el) => {
      const $el = $(el);
      const text = $el.text().replace(/^#\s*/, '').trim();
      if (text) {
        $el.replaceWith(`\n${'#'.repeat(i)} ${text}\n`);
      }
    });
  }

  // ── 表格 ────────────────────────────────────────────────────────────

  $('table').each((_i, el) => {
    const $table = $(el);
    const rows: string[][] = [];

    $table.find('tr').each((_j, tr) => {
      const cells: string[] = [];
      $(tr)
        .find('th, td')
        .each((_k, cell) => {
          const $cell = $(cell);
          // 保留链接文本
          $cell.find('a').each((_l, a) => {
            const $a = $(a);
            const href = $a.attr('href') || '';
            const text = $a.text().trim();
            if (href && text) {
              $a.replaceWith(`[${text}](${href})`);
            }
          });
          cells.push($cell.text().trim().replace(/\n/g, ' ').replace(/\|/g, '\\|'));
        });
      if (cells.length > 0) {
        rows.push(cells);
      }
    });

    if (rows.length === 0) return;

    const colCount = Math.max(...rows.map((r) => r.length));
    let md = '\n';
    rows.forEach((row, idx) => {
      while (row.length < colCount) row.push('');
      md += '| ' + row.join(' | ') + ' |\n';
      if (idx === 0) {
        md += '| ' + row.map(() => '---').join(' | ') + ' |\n';
      }
    });
    md += '\n';
    $table.replaceWith(md);
  });

  // ── blockquote ──────────────────────────────────────────────────────

  $('blockquote').each((_i, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      const lines = text
        .split('\n')
        .map((l: string) => `> ${l.trim()}`)
        .join('\n');
      $el.replaceWith(`\n${lines}\n`);
    }
  });

  // ── 链接 ────────────────────────────────────────────────────────────

  $('a').each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const text = $el.text().trim();
    if (href && text) {
      $el.replaceWith(`[${text}](${href})`);
    } else if (text) {
      $el.replaceWith(text);
    }
  });

  // ── 列表 ────────────────────────────────────────────────────────────

  $('ul').each((_i, el) => {
    const $el = $(el);
    let md = '\n';
    $el.find('> li').each((_j, li) => {
      md += `- ${$(li).text().trim()}\n`;
    });
    $el.replaceWith(md + '\n');
  });

  $('ol').each((_i, el) => {
    const $el = $(el);
    let md = '\n';
    $el.find('> li').each((j, li) => {
      md += `${j + 1}. ${$(li).text().trim()}\n`;
    });
    $el.replaceWith(md + '\n');
  });

  // ── 加粗 / 斜体 ────────────────────────────────────────────────────

  $('strong, b').each((_i, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`**${text}**`);
  });

  $('em, i').each((_i, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`*${text}*`);
  });

  // ── 图片 ────────────────────────────────────────────────────────────

  $('img').each((_i, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    const alt = $el.attr('alt') || '';
    if (src) {
      $el.replaceWith(`![${alt}](${src})`);
    }
  });

  // ── 换行 / 分隔线 ──────────────────────────────────────────────────

  $('br').replaceWith('\n');
  $('hr').replaceWith('\n---\n');

  // ── 提取文本并清理 ──────────────────────────────────────────────────

  const markdown = $.text()
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();

  return markdown;
}

// ─── API 路径提取 ──────────────────────────────────────────────────────────

/**
 * 从 Markdown 中提取 API 路径。
 * 微信小店 API 格式：
 * - GET https://api.weixin.qq.com/cgi-bin/token
 * - POST https://api.weixin.qq.com/channels/ec/product/add
 * - POST https://api.weixin.qq.com/shop/...
 */
function extractApiPath(md: string): string | undefined {
  const patterns = [
    // 完整 URL：GET/POST https://api.weixin.qq.com/...
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/api\.weixin\.qq\.com[^\s`'"<>]+)/i,
    // 路径形式：/cgi-bin/... /channels/... /shop/... 等
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/(?:cgi-bin|wxa|channels|shop|product|cv|sns|wxaapi|card|nontax|intp|promoter|union|componenttcb|customservice)[^\s`'"<>]+)/i,
  ];

  for (const pat of patterns) {
    const m = md.match(pat);
    if (m) return m[1];
  }
  return undefined;
}

// ─── 错误码提取 ────────────────────────────────────────────────────────────

function extractErrorCodes(
  md: string,
): Array<{ code: string; message?: string; description?: string }> {
  // 匹配错误码表格行：| -1 | system error | 系统繁忙 |
  const regex = /\|\s*(-?\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;
  const codes: Array<{ code: string; message?: string; description?: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = regex.exec(md)) !== null) {
    const code = m[1].trim();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push({
      code,
      message: m[2]?.trim() || undefined,
      description: m[3]?.trim() || undefined,
    });
  }
  return codes;
}

// ─── 文档类型推断 ──────────────────────────────────────────────────────────

function detectDocType(path: string, href: string): string {
  const lower = (path + ' ' + href).toLowerCase();
  if (lower.includes('notify') || lower.includes('callback') || lower.includes('事件')) return 'event';
  if (lower.includes('errcode') || lower.includes('错误码') || lower.includes('commerr')) return 'error_code';
  if (
    lower.includes('dev_before') ||
    lower.includes('dev_guide') ||
    lower.includes('develop_guide') ||
    lower.includes('开发须知') ||
    lower.includes('开发指南') ||
    lower.includes('example_description') ||
    lower.includes('qualification_license') ||
    lower.includes('资质') ||
    lower.includes('changelog') ||
    lower.includes('变更日志') ||
    lower.includes('linkstore') ||
    lower.includes('连接小店')
  )
    return 'guide';
  return 'api_reference';
}

// ─── Sidebar link extraction ────────────────────────────────────────────────

/**
 * 从页面中提取侧边栏导航链接。
 * 微信小店文档使用服务端渲染 HTML，侧边栏为嵌套 <ul>/<li>/<a> 结构。
 *
 * 尝试多种选择器，按优先级：
 * 1. .sidebar 容器
 * 2. nav 元素
 * 3. 全页面中匹配路径模式的链接（fallback）
 */
function extractSidebarLinks($: CheerioAPI): DocEntry[] {
  const entries: DocEntry[] = [];
  const seen = new Set<string>();

  // 尝试从已知的侧边栏容器中提取
  const sidebarSelectors = [
    '.sidebar a',
    'nav a',
    '.left-nav a',
    '.tree-nav a',
    '.doc-nav a',
    '.aside a',
    'aside a',
  ];

  let found = false;

  for (const selector of sidebarSelectors) {
    const links = $(selector);
    if (links.length < 10) continue; // 太少的链接不像侧边栏

    links.each((_i, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      const text = $a.text().trim();

      if (!href || !text) return;
      if (!href.includes('/doc/store/shop/')) return;
      if (!href.endsWith('.html')) return;
      if (seen.has(href)) return;
      seen.add(href);

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

      // 从 href 构建层次路径
      const pathSegment = href.replace(DOC_PATH_PREFIX, '').replace(/\.html$/, '');
      const parts = pathSegment.split('/').filter(Boolean);
      const path = parts.length > 0 ? parts.join('/') : text;

      entries.push({
        path,
        title: text,
        sourceUrl: fullUrl,
        docType: detectDocType(path, href),
        platformId: href,
      });
    });

    if (entries.length > 0) {
      found = true;
      break;
    }
  }

  // Fallback: 全页面搜索匹配模式的链接
  if (!found) {
    console.log('[wechat-shop] 侧边栏选择器未命中，使用全页面 fallback');
    $('a').each((_i, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      const text = $a.text().trim();

      if (!href || !text) return;
      if (!href.includes('/doc/store/shop/')) return;
      if (!href.endsWith('.html')) return;
      if (seen.has(href)) return;
      seen.add(href);

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const pathSegment = href.replace(DOC_PATH_PREFIX, '').replace(/\.html$/, '');
      const parts = pathSegment.split('/').filter(Boolean);
      const path = parts.length > 0 ? parts.join('/') : text;

      entries.push({
        path,
        title: text,
        sourceUrl: fullUrl,
        docType: detectDocType(path, href),
        platformId: href,
      });
    });
  }

  return entries;
}

// ─── 内容区域选择器 ──────────────────────────────────────────────────────────

/**
 * 尝试多种选择器定位内容区域。
 */
function findContentHtml($: CheerioAPI): string {
  const selectors = ['.content', '.doc-content', '.article-content', 'article', 'main', '.markdown-body'];

  for (const sel of selectors) {
    const el = $(sel);
    if (el.length > 0 && el.text().trim().length > 50) {
      return el.html() || '';
    }
  }

  return '';
}

// ─── WechatShopSource class ─────────────────────────────────────────────────

export class WechatShopSource implements DocSource {
  id = 'wechat-shop';
  name = '微信小店';

  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 100 === 0) {
      console.log(`[wechat-shop] 已处理 ${this.requestCount} 个请求`);
    }
    await randomDelay(BASE_DELAY, JITTER);
  }

  // ─── DocSource interface ───────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[wechat-shop] 获取文档目录...');

    const resp = await this.client.get(CATALOG_URL);
    const $ = load(resp.data as string);

    const entries = extractSidebarLinks($);

    if (entries.length === 0) {
      console.warn('[wechat-shop] 未能从目录页提取链接，尝试从 API 子页面提取...');
      // 尝试从 API 子页面提取（某些文档站首页可能不包含完整导航）
      const apiResp = await this.client.get(`${CATALOG_URL}API/apimgnt/api_getaccesstoken.html`);
      const $api = load(apiResp.data as string);
      const apiEntries = extractSidebarLinks($api);
      if (apiEntries.length > 0) {
        console.log(`[wechat-shop] 从 API 子页面提取到 ${apiEntries.length} 篇文档`);
        return apiEntries;
      }
    }

    console.log(`[wechat-shop] 目录加载完成: ${entries.length} 篇文档`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    if (!entry.sourceUrl) {
      throw new Error(`缺少 sourceUrl: ${entry.title}`);
    }

    await this.throttle();

    const resp = await this.client.get(entry.sourceUrl, {
      maxRedirects: 5,
    });

    const html = resp.data as string;
    const $ = load(html);

    const contentHtml = findContentHtml($);
    if (!contentHtml || contentHtml.trim().length < 50) {
      throw new Error(`页面内容为空: ${entry.title} (${entry.sourceUrl})`);
    }

    const markdown = contentHtmlToMarkdown(contentHtml);
    const apiPath = extractApiPath(markdown);
    const errorCodes = extractErrorCodes(markdown);

    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    return {
      markdown,
      apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
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
