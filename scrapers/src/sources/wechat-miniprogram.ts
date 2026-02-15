import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { tokenize } from '../utils/tokenizer.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://developers.weixin.qq.com';
const CATALOG_URL = `${BASE_URL}/miniprogram/dev/OpenApiDoc/`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 请求间隔（ms）— 微信文档站较宽松 */
const BASE_DELAY = 500;
/** 请求间隔随机抖动范围（ms） */
const JITTER = 300;

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function randomDelay(base: number, jitter: number): Promise<void> {
  const ms = base + Math.floor(Math.random() * jitter);
  return delay(ms);
}

// ─── HTML → Markdown conversion ─────────────────────────────────────────────

/**
 * 将微信文档 .content 区域的 HTML 转换为 Markdown。
 * 接收 cheerio 实例和 HTML 字符串。
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
 * 微信 API 格式：
 * - GET https://api.weixin.qq.com/cgi-bin/token
 * - POST https://api.weixin.qq.com/wxa/business/getuserphonenumber
 */
function extractApiPath(md: string): string | undefined {
  const patterns = [
    // 完整 URL：GET/POST https://api.weixin.qq.com/...
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/api\.weixin\.qq\.com[^\s`'"<>]+)/i,
    // 路径形式：/cgi-bin/... or /wxa/...
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/(?:cgi-bin|wxa|cv|sns|wxaapi|card|nontax|intp|product|channels|shop|promoter|union|componenttcb|customservice)[^\s`'"<>]+)/i,
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
  if (lower.includes('event_push') || lower.includes('事件')) return 'event';
  if (lower.includes('error') || lower.includes('错误码')) return 'error_code';
  if (lower.includes('getting_started') || lower.includes('开发前必读') || lower.includes('签名'))
    return 'guide';
  return 'api_reference';
}

// ─── Navigation tree extraction ─────────────────────────────────────────────

interface NavNode {
  text: string;
  href: string | null;
  children: NavNode[];
}

/**
 * 从侧边栏的 TreeNavigation 组件递归提取导航树。
 */
function extractNavTree($: CheerioAPI): NavNode[] {
  const sidebar = $('.sidebar .TreeNavigation');
  if (sidebar.length === 0) return [];

  function walk(ulSelector: ReturnType<CheerioAPI>): NavNode[] {
    const nodes: NavNode[] = [];
    ulSelector.find(':scope > li').each((_i, li) => {
      const $li = $(li);

      let text = '';
      let href: string | null = null;

      // NavigationLevel（有子节点的分组）
      const parentSpan = $li.find(':scope > .NavigationLevel > .NavigationLevel__parent .NavigationItem').first();
      if (parentSpan.length > 0) {
        const link = parentSpan.find('a.NavigationItem__router-link').first();
        text = link.text().trim() || parentSpan.text().trim();
        href = link.attr('href') || null;
      } else {
        // 直接是 NavigationItem（叶子节点）
        const link = $li.find(':scope > .NavigationItem a.NavigationItem__router-link').first();
        if (link.length > 0) {
          text = link.text().trim();
          href = link.attr('href') || null;
        } else {
          text = $li.children().first().text().trim();
        }
      }

      // 递归处理子节点
      const childUl = $li.find(':scope > .NavigationLevel .NavigationLevel__children').first();
      const children = childUl.length > 0 ? walk(childUl) : [];

      if (text) {
        nodes.push({ text, href, children });
      }
    });
    return nodes;
  }

  const rootUl = sidebar.find(':scope > .NavigationLevel--level-0 > ul').first();
  return rootUl.length > 0 ? walk(rootUl) : [];
}

/**
 * 将导航树扁平化为 DocEntry 列表。
 * 只收集有 .html 链接的叶子节点。
 */
function flattenNavTree(nodes: NavNode[]): DocEntry[] {
  const entries: DocEntry[] = [];
  const seen = new Set<string>();

  function collect(nodes: NavNode[], path: string): void {
    for (const node of nodes) {
      const currentPath = path ? `${path}/${node.text}` : node.text;

      if (node.href && node.href.endsWith('.html')) {
        if (!seen.has(node.href)) {
          seen.add(node.href);
          const fullUrl = node.href.startsWith('http')
            ? node.href
            : `${BASE_URL}${node.href}`;

          entries.push({
            path: currentPath,
            title: node.text,
            sourceUrl: fullUrl,
            docType: detectDocType(currentPath, node.href),
            platformId: node.href,
          });
        }
      }

      if (node.children.length > 0) {
        collect(node.children, currentPath);
      }
    }
  }

  collect(nodes, '');
  return entries;
}

// ─── WechatMiniprogramSource class ──────────────────────────────────────────

export class WechatMiniprogramSource implements DocSource {
  id = 'wechat-miniprogram';
  name = '微信小程序';

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
      console.log(`[wechat-miniprogram] 已处理 ${this.requestCount} 个请求`);
    }
    await randomDelay(BASE_DELAY, JITTER);
  }

  // ─── DocSource interface ───────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[wechat-miniprogram] 获取文档目录...');

    const resp = await this.client.get(CATALOG_URL);
    const $ = load(resp.data as string);

    const navTree = extractNavTree($);

    if (navTree.length === 0) {
      console.log('[wechat-miniprogram] TreeNavigation 提取失败，使用 fallback 方式');
      return this.fallbackCatalog($);
    }

    const entries = flattenNavTree(navTree);
    console.log(
      `[wechat-miniprogram] 目录加载完成: ${entries.length} 篇文档`,
    );
    return entries;
  }

  /** Fallback: 直接提取侧边栏所有 .html 链接 */
  private fallbackCatalog($: CheerioAPI): DocEntry[] {
    const entries: DocEntry[] = [];
    const seen = new Set<string>();

    $('.sidebar a').each((_i, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      const text = $a.text().trim();

      if (!href || !href.endsWith('.html') || seen.has(href)) return;
      seen.add(href);

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const pathParts = href.split('/').filter(Boolean);
      const path = pathParts.slice(pathParts.indexOf('server') + 1, -1).join('/');

      entries.push({
        path: path ? `${path}/${text}` : text,
        title: text,
        sourceUrl: fullUrl,
        docType: detectDocType(text, href),
        platformId: href,
      });
    });

    console.log(
      `[wechat-miniprogram] Fallback 目录加载完成: ${entries.length} 篇文档`,
    );
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

    const contentEl = $('.content');
    if (contentEl.length === 0 || contentEl.text().trim().length < 50) {
      throw new Error(`页面内容为空: ${entry.title} (${entry.sourceUrl})`);
    }

    // 提取 .content 内部 HTML 并转换
    const contentHtml = contentEl.html() || '';
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
