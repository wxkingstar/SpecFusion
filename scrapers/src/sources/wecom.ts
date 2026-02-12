import axios, { type AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import fs from 'fs-extra';
import path from 'path';
import converter from 'html-to-markdown';
import { load } from 'cheerio';
import sanitize from 'sanitize-filename';
import { decode } from 'html-entities';
import { chromium } from 'playwright';
import { tokenize } from '../utils/tokenizer.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://developer.work.weixin.qq.com';
const BASE_REFERER = `${BASE_URL}/document/path/90664`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const LAST_UPDATED_REGEX = /最后更新[:：]\s*(\d{4})[./-](\d{1,2})[./-](\d{1,2})/i;
const COOKIE_FILE = path.resolve('.wecom_cookies.json');

/** devMode 映射：URL 路径片段 → 模式名称 */
const DEV_MODE_MAP: Record<string, string> = {
  '/is_third/1': 'third_party',
  '/is_sp/1': 'service_provider',
};

/** API 路径提取正则 */
const API_PATH_REGEX = /(?:(?:GET|POST|PUT|DELETE|PATCH)\s+)?`?(\/cgi-bin\/[^\s`'"<>]+)`?/i;

/** 错误码提取正则：匹配表格行中的错误码 */
const ERROR_CODE_REGEX = /\|\s*(\d{3,6})\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseDateParts(year: string, month: string, day: string): Date | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function timestampToDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const millis = value > 1e12 ? value : value * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function extractLastUpdatedFromHtml(html: string): Date | null {
  if (!html) return null;
  const $ = load(html);
  const text = $('body').text() || '';
  const match = text.match(LAST_UPDATED_REGEX);
  if (!match) return null;
  return parseDateParts(match[1], match[2], match[3]);
}

function extractLastUpdatedFromMarkdown(markdown: string): Date | null {
  if (!markdown) return null;
  const match = markdown.match(LAST_UPDATED_REGEX);
  if (!match) return null;
  return parseDateParts(match[1], match[2], match[3]);
}

function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1');
}

function slugify(title: string): string {
  const sanitized = sanitize(title.replace(/\//g, ' '));
  const collapsed = sanitized.replace(/\s+/g, '-');
  const ascii = collapsed.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const trimmed = ascii.replace(/[^a-zA-Z0-9\-_.\u4e00-\u9fa5]/g, '');
  return trimmed || 'document';
}

// ─── Tree node interface (internal) ─────────────────────────────────────────

interface CategoryNode {
  category_id: number;
  parent_id: number;
  doc_id: number;
  title: string;
  order_id?: number;
  type?: number;
  status?: number;
  children: CategoryNode[];
  url?: string;
}

// ─── HTML → Markdown pipeline ───────────────────────────────────────────────

function preprocessHtml(rawHtml: string): string {
  const $ = load(rawHtml || '', { decodeEntities: false } as Parameters<typeof load>[1]);
  // Use type assertion: $.root() returns Cheerio<Document>, $('body') returns Cheerio<Element>
  const root: ReturnType<typeof $> = ($('body').length ? $('body') : $.root()) as ReturnType<typeof $>;

  // Remove script and style tags
  root.find('script, style').remove();

  // Process <pre> code blocks
  $('pre').each((_, el) => {
    const $el = $(el);
    const $code = $el.children('code').first();
    let codeText = '';
    let language = '';
    if ($code.length) {
      const classAttr = $code.attr('class') || '';
      const langMatch =
        classAttr.match(/language-([\w+-]+)/i) || classAttr.match(/lang-([\w+-]+)/i);
      if (langMatch) language = langMatch[1];
      codeText = $code.html() ?? $code.text();
    } else {
      codeText = $el.html() ?? $el.text();
    }
    const textWithLineBreaks = (codeText || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const decoded = decode(textWithLineBreaks);
    const normalized = decoded.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    const content = normalized.replace(/\n{3,}/g, '\n\n').trimEnd();
    const langLabel = (language || '').trim();
    const fenceHeader = langLabel ? `\`\`\`${langLabel}` : '```';
    const fence = `\n${fenceHeader}\n${content}\n\`\`\`\n`;
    $el.replaceWith(fence);
  });

  // Process inline <code> (not inside <pre>)
  $('code').each((_, el) => {
    const $el = $(el);
    if ($el.parent().is('pre')) return;
    const text = decode($el.text());
    const escaped = text.replace(/`/g, '\\`');
    $el.replaceWith('`' + escaped + '`');
  });

  // Process <img>
  $('img').each((_, el) => {
    const $el = $(el);
    const src = ($el.attr('src') || '').trim();
    const alt = decode($el.attr('alt') || '');
    const title = decode($el.attr('title') || '');
    if (!src) {
      $el.replaceWith(alt);
      return;
    }
    const titlePart = title ? ` "${escapeMarkdown(title)}"` : '';
    $el.replaceWith(`![${escapeMarkdown(alt)}](${src}${titlePart})`);
  });

  // Process <br> and <hr>
  $('br').each((_, el) => {
    $(el).replaceWith('\n');
  });
  $('hr').each((_, el) => {
    $(el).replaceWith('\n\n---\n\n');
  });

  // Strip non-essential attributes
  root.find('*').each((_, element) => {
    const $elem = $(element);
    const allowed = new Set(['href', 'src', 'alt', 'title']);
    if (element.attribs) {
      for (const attr of Object.keys(element.attribs)) {
        if (!allowed.has(attr)) {
          $elem.removeAttr(attr);
        }
      }
    }
  });

  return root.html() || rawHtml || '';
}

function postProcessMarkdown(markdown: string): string {
  let output = markdown;
  // Convert residual <a> tags to markdown links
  output = output.replace(/<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
    const hrefMatch =
      attrs.match(/href\s*=\s*"([^"]+)"/i) || attrs.match(/href\s*=\s*'([^']+)'/i);
    const href = hrefMatch ? hrefMatch[1] : '';
    if (!href) return inner;
    const titleMatch =
      attrs.match(/title\s*=\s*"([^"]+)"/i) || attrs.match(/title\s*=\s*'([^']+)'/i);
    const title = titleMatch ? titleMatch[1] : '';
    const cleanedInner = inner.replace(/<[^>]+>/g, '');
    const decodedInner = decode(cleanedInner).trim() || href;
    const escapedInner = decodedInner.replace(/\]/g, '\\]');
    const titlePart = title ? ` "${escapeMarkdown(title)}"` : '';
    return `[${escapedInner}](${href}${titlePart})`;
  });
  output = output.replace(/&nbsp;/gi, ' ');
  output = output.replace(/\r\n/g, '\n');
  output = output.replace(/\n{3,}/g, '\n\n');
  return output.trim();
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<p>\s*<\/p>/gi, '')
    .replace(/<\/?(div|span)[^>]*>/gi, '')
    .replace(/<img\s+[^>]*alt="([^"]*)"[^>]*src="([^"]+)"[^>]*>/gi, '![$1]($2)')
    .replace(/<img\s+[^>]*src="([^"]+)"[^>]*>/gi, '![]($1)')
    .replace(/\s*!\[/g, '\n![')
    .replace(/^!\[/gm, '- ![')
    .replace(/ {2,}/g, ' ')
    .replace(/\t/g, '  ')
    .replace(/\u3000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Content extraction helpers ─────────────────────────────────────────────

function extractApiPath(markdown: string): string | undefined {
  const match = markdown.match(API_PATH_REGEX);
  return match ? match[1] : undefined;
}

function extractErrorCodes(
  markdown: string,
): Array<{ code: string; message?: string; description?: string }> {
  const codes: Array<{ code: string; message?: string; description?: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset lastIndex for global regex
  ERROR_CODE_REGEX.lastIndex = 0;
  while ((m = ERROR_CODE_REGEX.exec(markdown)) !== null) {
    const code = m[1].trim();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push({
      code,
      message: m[2]?.trim() || undefined,
      description: m[3]?.trim() || undefined,
    });
  }
  return codes.length > 0 ? codes : [];
}

// ─── Tree building ──────────────────────────────────────────────────────────

function sortChildren(children: CategoryNode[]): CategoryNode[] {
  return [...children].sort((a, b) => {
    const orderDelta = (a.order_id || 0) - (b.order_id || 0);
    if (orderDelta !== 0) return orderDelta;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

function buildTree(categories: CategoryNode[]): CategoryNode[] {
  const nodes = new Map<number, CategoryNode>();
  for (const item of categories) {
    nodes.set(item.category_id, { ...item, children: [] });
  }
  const roots: CategoryNode[] = [];
  for (const item of categories) {
    if (item.parent_id === 0) {
      roots.push(nodes.get(item.category_id)!);
    } else {
      const parent = nodes.get(item.parent_id);
      if (parent) {
        parent.children.push(nodes.get(item.category_id)!);
      }
    }
  }
  const prune = (list: CategoryNode[]): CategoryNode[] => {
    return sortChildren(list.filter((node) => node.status === 2)).map((node) => ({
      ...node,
      children: prune(node.children || []),
    }));
  };
  return prune(roots);
}

// ─── Walk tree → flat DocEntry list ─────────────────────────────────────────

interface WalkContext {
  entries: DocEntry[];
}

function walkTree(
  nodes: CategoryNode[],
  parentPath: string,
  depth: number,
  ctx: WalkContext,
): void {
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    const orderPrefix = String(index + 1).padStart(3, '0');
    const baseSlug = slugify(node.title);
    let entryName = `${orderPrefix}-${baseSlug}`;
    if (seen.has(entryName)) {
      entryName = `${entryName}-${node.category_id}`;
    }
    seen.add(entryName);

    const currentPath = parentPath ? `${parentPath}/${entryName}` : entryName;

    // Folder (type 0) or virtual container (doc_id=0 with children) → recurse
    if (node.type === 0 || (node.doc_id === 0 && node.children?.length)) {
      walkTree(node.children || [], currentPath, depth + 1, ctx);
      return;
    }

    // Leaf document
    if (node.doc_id) {
      const docPathId = String(node.category_id || node.doc_id);
      const sourceUrl = `${BASE_URL}/document/path/${docPathId}`;

      // Detect devMode from URL path
      let devMode: string | undefined;
      if (node.url) {
        for (const [pattern, mode] of Object.entries(DEV_MODE_MAP)) {
          if (node.url.includes(pattern)) {
            devMode = mode;
            break;
          }
        }
      }
      // Fallback: detect from source URL or path context
      if (!devMode) {
        if (sourceUrl.includes('/is_third/1') || currentPath.includes('third')) {
          devMode = 'third_party';
        } else if (sourceUrl.includes('/is_sp/1') || currentPath.includes('service_provider')) {
          devMode = 'service_provider';
        } else {
          devMode = 'internal';
        }
      }

      ctx.entries.push({
        path: currentPath,
        title: node.title,
        devMode,
        sourceUrl,
        platformId: String(node.doc_id),
      });
    }
  });
}

// ─── WecomSource class ──────────────────────────────────────────────────────

/**
 * 企业微信文档源适配器
 * 迁移自 doc-hub-mcp/scripts/wecom-scraper.js
 */
export class WecomSource implements DocSource {
  id = 'wecom';
  name = '企业微信';

  private jar: CookieJar;
  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        baseURL: BASE_URL,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeout: 20000,
        withCredentials: true,
      }),
    );
    (this.client.defaults as any).jar = this.jar;
    (this.client.defaults as any).withCredentials = true;

    // Load cookies from env and file
    this.importCookiesFromEnv(process.env.WECOM_COOKIES || '');
    this.importCookiesFromFile(COOKIE_FILE);
  }

  // ─── Cookie management ──────────────────────────────────────────────────

  private importCookiesFromEnv(cookies: string): void {
    if (!cookies) return;
    cookies
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const [name, ...rest] = entry.split('=');
        if (!name || !rest.length) return;
        const value = rest.join('=');
        try {
          this.jar.setCookieSync(`${name.trim()}=${value}`, BASE_URL);
        } catch (err: any) {
          console.warn('Failed to set cookie from env:', name.trim(), err.message);
        }
      });
  }

  private importCookiesFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        data.forEach((cookie: any) => {
          if (!cookie || !cookie.name || cookie.value === undefined) return;
          const domain = cookie.domain || '.work.weixin.qq.com';
          const pathValue = cookie.path || '/';
          try {
            this.jar.setCookieSync(
              `${cookie.name}=${cookie.value}; Domain=${domain}; Path=${pathValue}`,
              BASE_URL,
            );
          } catch (err: any) {
            console.warn('Failed to set cookie from file:', cookie.name, err.message);
          }
        });
      } else if (typeof data === 'string') {
        this.importCookiesFromEnv(data);
      }
    } catch (error: any) {
      console.warn('Unable to parse cookie file', filePath, error.message);
    }
  }

  /**
   * 验证 Cookie 是否有效：请求一篇已知文档，检查返回是否包含文档内容
   */
  async checkCookieHealth(): Promise<boolean> {
    try {
      const testDocId = '90664'; // 已知存在的企业微信文档
      const headers = {
        Referer: `${BASE_URL}/document/path/${testDocId}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      };
      const body = new URLSearchParams({ doc_id: testDocId }).toString();
      const response = await this.client.post('/docFetch/fetchCnt', body, { headers });
      const payload = response.data;

      // Check for captcha or auth failure
      if (payload?.result?.errCode === 500003) return false;
      if (typeof payload === 'string' && payload.includes('showDeveloperCaptcha')) return false;
      if (!payload?.data) return false;

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 打开浏览器让用户登录，登录成功后自动保存 cookies 并导入到请求客户端
   */
  async openBrowserForLogin(
    targetUrl = `${BASE_URL}/document/path/90664`,
  ): Promise<boolean> {
    console.log('\n[wecom] 正在打开浏览器进行登录...');
    console.log('[wecom] 请在浏览器中完成登录/验证，完成后页面会自动关闭。\n');

    const browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized'],
    });

    const context = await browser.newContext({
      viewport: null,
      userAgent: USER_AGENT,
    });

    const page = await context.newPage();

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

      console.log('[wecom] 等待登录/验证完成...');

      // waitForFunction runs in browser context; use string to avoid TS DOM type errors
      await page.waitForFunction(
        `(() => {
          const docContent = document.querySelector('.doc-content, .markdown-body, [class*="doc-"]');
          const loginForm = document.querySelector('[class*="login"], [class*="captcha"], [class*="verify"]');
          return docContent && !loginForm;
        })()`,
        { timeout: 300000 }, // 5 分钟超时
      );

      console.log('[wecom] 检测到登录/验证成功！');

      const cookies = await context.cookies();
      const relevantCookies = cookies.filter(
        (c) =>
          c.domain.includes('work.weixin.qq.com') || c.domain.includes('weixin.qq.com'),
      );

      if (relevantCookies.length > 0) {
        await fs.writeJson(COOKIE_FILE, relevantCookies, { spaces: 2 });
        console.log(
          `[wecom] 已保存 ${relevantCookies.length} 个 cookies 到 ${COOKIE_FILE}`,
        );

        // 导入 cookies 到 axios jar
        for (const cookie of relevantCookies) {
          const domain = cookie.domain.startsWith('.')
            ? cookie.domain
            : `.${cookie.domain}`;
          try {
            this.jar.setCookieSync(
              `${cookie.name}=${cookie.value}; Domain=${domain}; Path=${cookie.path || '/'}`,
              BASE_URL,
            );
          } catch {
            // 忽略 cookie 设置错误
          }
        }

        console.log('[wecom] 已将 cookies 导入到请求客户端\n');
        return true;
      } else {
        console.warn('[wecom] 未获取到有效的 cookies');
        return false;
      }
    } catch (error: any) {
      if (error.name === 'TimeoutError') {
        console.error('[wecom] 登录超时（5分钟），请重试');
      } else {
        console.error('[wecom] 登录过程出错:', error.message);
      }
      return false;
    } finally {
      await browser.close();
    }
  }

  // ─── Adaptive rate limiting ─────────────────────────────────────────────

  private getDelayMs(): number {
    if (this.requestCount < 100) return 1200;
    if (this.requestCount < 200) return 1800;
    return 2500;
  }

  private async throttle(): Promise<void> {
    this.requestCount++;
    await delay(this.getDelayMs());
  }

  // ─── API calls ──────────────────────────────────────────────────────────

  private async fetchCategories(): Promise<CategoryNode[]> {
    const headers = {
      Referer: BASE_REFERER,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    const response = await this.client.post('/docFetch/categories', {}, { headers });
    const data = response.data;
    if (data?.data?.categories) return data.data.categories;
    if (data?.categories) return data.categories;
    throw new Error('Unexpected categories response — Cookie may be invalid');
  }

  private async fetchDocContent(
    docId: string,
    attempt = 0,
  ): Promise<{
    title?: string;
    content_html_v2?: string;
    content_html?: string;
    content_md?: string;
    time?: number;
    extra?: { update_time?: number };
    last_update_time?: number;
    last_update_time_str?: string;
    doc_id?: string;
    pageHtml?: string;
  }> {
    const headers = {
      Referer: `${BASE_URL}/document/path/${docId}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    };
    const body = new URLSearchParams({ doc_id: String(docId) }).toString();
    try {
      let pageHtml = '';
      if (attempt === 0) {
        const pageResponse = await this.client.get(`/document/path/${docId}`, {
          headers: { Referer: BASE_REFERER },
        });
        pageHtml = pageResponse?.data ?? '';
        await delay(500);
      }
      const response = await this.client.post('/docFetch/fetchCnt', body, { headers });
      const payload = response.data;

      if (payload?.data) {
        return { ...payload.data, pageHtml };
      }
      if (payload?.result?.errCode === 500003) {
        throw new Error(`Doc ${docId} fetch error: 500003 人机验证`);
      }
      if (payload?.result?.errCode) {
        throw new Error(
          `Doc ${docId} fetch error: ${payload.result.errCode} ${payload.result.humanMessage || ''}`,
        );
      }
      if (typeof payload === 'string' && payload.includes('showDeveloperCaptcha')) {
        throw new Error(`Doc ${docId} fetch error: 500003 人机验证`);
      }
      return payload;
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.message || '';
      // Retry on 429 rate limit or 500003 captcha
      if ((status === 429 || message.includes('429')) && attempt < 5) {
        const waitMs = 1500 * (attempt + 1);
        console.warn(
          `429 rate limit for doc ${docId}, retrying after ${waitMs}ms (attempt ${attempt + 1})`,
        );
        await delay(waitMs);
        return this.fetchDocContent(docId, attempt + 1);
      }
      if (message.includes('500003') && attempt < 3) {
        const waitMs = 3000 * (attempt + 1);
        console.warn(
          `500003 captcha for doc ${docId}, retrying after ${waitMs}ms (attempt ${attempt + 1})`,
        );
        await delay(waitMs);
        return this.fetchDocContent(docId, attempt + 1);
      }
      throw error;
    }
  }

  // ─── DocSource interface ────────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    // Validate cookies first
    let healthy = await this.checkCookieHealth();
    if (!healthy) {
      console.warn('[wecom] Cookie 无效或已过期，尝试打开浏览器登录...');
      const loginSuccess = await this.openBrowserForLogin();
      if (loginSuccess) {
        healthy = await this.checkCookieHealth();
      }
      if (!healthy) {
        throw new Error(
          'Cookie 无效或已过期。请手动获取企业微信开发者文档的 Cookie：\n' +
            '1. 在浏览器中打开 https://developer.work.weixin.qq.com/document/path/90664\n' +
            '2. 登录后，通过开发者工具获取 Cookie\n' +
            '3. 保存到 .wecom_cookies.json 或设置环境变量 WECOM_COOKIES',
        );
      }
    }

    console.log('[wecom] Fetching category tree...');
    const categories = await this.fetchCategories();
    const tree = buildTree(categories);

    const ctx: WalkContext = { entries: [] };
    walkTree(tree, '', 0, ctx);

    console.log(`[wecom] Found ${ctx.entries.length} documents in catalog`);
    return ctx.entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const docId = entry.platformId;
    if (!docId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    await this.throttle();

    const doc = await this.fetchDocContent(docId);
    const rawHtml = doc.content_html_v2 || doc.content_html || '';

    // Determine last updated date
    const remoteUpdatedAt = (() => {
      const preferred = timestampToDate(doc.time);
      if (preferred) return preferred;
      const fromHtml =
        extractLastUpdatedFromHtml(rawHtml) ?? extractLastUpdatedFromHtml(doc.pageHtml || '');
      const candidates = [
        fromHtml,
        timestampToDate(doc.extra?.update_time),
        timestampToDate(doc.last_update_time),
        doc.last_update_time_str ? new Date(doc.last_update_time_str) : null,
      ].filter((d): d is Date => d !== null);
      if (candidates.length === 0) return null;
      return new Date(Math.max(...candidates.map((date) => date.getTime())));
    })();

    // HTML → Markdown conversion pipeline
    const processedHtml = preprocessHtml(rawHtml);
    let markdownBody: string;
    if (doc.content_md && doc.content_md.trim()) {
      markdownBody = doc.content_md.trim();
    } else {
      markdownBody = postProcessMarkdown((converter as any).convert(processedHtml));
    }
    const markdown = cleanupMarkdown(markdownBody);

    // Extract API path from content
    const apiPath = extractApiPath(markdown);

    // Extract error codes from content
    const errorCodes = extractErrorCodes(markdown);

    // Jieba tokenization for search indexing
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (remoteUpdatedAt) {
      metadata.lastUpdated = formatDate(remoteUpdatedAt);
    }
    if (doc.title) {
      metadata.remoteTitle = doc.title;
    }
    metadata.tokenizedTitle = tokenizedTitle;
    metadata.tokenizedContent = tokenizedContent;

    return {
      markdown,
      apiPath: apiPath || entry.apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(since: Date): Promise<DocEntry[]> {
    // Fetch the full catalog and filter by date
    // The wecom API does not provide a dedicated "changes since" endpoint,
    // so we rely on fetching all entries and checking dates during fetchContent.
    // For detectUpdates, we return the full catalog and let the sync layer
    // compare with stored lastUpdated timestamps.
    const catalog = await this.fetchCatalog();
    // We cannot pre-filter by date without fetching content,
    // so return all entries and let the caller handle incremental comparison.
    return catalog;
  }

  // ─── Quality gate ───────────────────────────────────────────────────────

  /**
   * 质量门控：检查本次抓取文档数与上次的差异是否在合理范围内
   * @param currentCount 本次抓取的文档总数
   * @param lastCount 上次已知的文档总数
   * @returns true 如果通过门控检查，false 如果差异异常
   */
  checkQualityGate(currentCount: number, lastCount: number): boolean {
    if (lastCount <= 0) return true; // 首次抓取，无基准比较
    const ratio = currentCount / lastCount;
    // 如果文档数减少超过 20%，认为异常（可能 Cookie 失效导致部分目录不可见）
    if (ratio < 0.8) {
      console.warn(
        `[wecom] Quality gate FAIL: current=${currentCount}, last=${lastCount}, ratio=${ratio.toFixed(2)}. ` +
          'Document count dropped >20%, Cookie may be partially invalid.',
      );
      return false;
    }
    // 如果文档数增加超过 50%，也认为异常（可能 API 返回了重复数据）
    if (ratio > 1.5) {
      console.warn(
        `[wecom] Quality gate WARN: current=${currentCount}, last=${lastCount}, ratio=${ratio.toFixed(2)}. ` +
          'Unexpected document count increase >50%.',
      );
      // Warning only, still pass
    }
    return true;
  }
}
