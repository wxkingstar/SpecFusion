import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { decode } from 'html-entities';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://pay.weixin.qq.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms） */
const REQUEST_DELAY = 300;

/** 用于获取目录树的入口文档 ID */
const ENTRY_DOC_ID = '4012062524';

// ─── Menu tree interfaces ───────────────────────────────────────────────────

interface MenuNode {
  docId: string;
  parentId: string;
  title: string;
  updateTime: string; // unix timestamp string
  index: number;
  url: string;
  refDocUrl: string;
  redirectDocUrl: string;
  state: number;
  childrenList: MenuNode[];
  pathArray?: Array<{ title: string; url: string }>;
}

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── HTML → Markdown conversion ─────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';

  const $: CheerioAPI = load(html);

  // Remove style tags
  $('style').remove();

  // Convert code blocks
  $('pre').each((_, el) => {
    const $el = $(el);
    const code = $el.find('code');
    const lang = code.attr('class')?.replace(/^language-/, '') || '';
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

// ─── WechatPaySource class ──────────────────────────────────────────────────

export class WechatPaySource implements DocSource {
  id = 'wechat-pay';
  name = '微信支付';

  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[wechat-pay] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── Page context extraction ───────────────────────────────────────────

  /** 从 SSR 页面提取 vike_pageContext JSON */
  private extractPageContext(html: string): Record<string, unknown> | null {
    const marker = '<script id="vike_pageContext" type="application/json">';
    const start = html.indexOf(marker);
    if (start === -1) return null;

    const jsonStart = start + marker.length;
    const jsonEnd = html.indexOf('</script>', jsonStart);
    if (jsonEnd === -1) return null;

    try {
      return JSON.parse(html.substring(jsonStart, jsonEnd));
    } catch {
      return null;
    }
  }

  // ─── Menu tree traversal ──────────────────────────────────────────────

  /** 递归遍历目录树，收集所有叶子文档 */
  private collectLeafDocs(nodes: MenuNode[], parentPath: string): DocEntry[] {
    const entries: DocEntry[] = [];

    for (const node of nodes) {
      const currentPath = parentPath ? `${parentPath}/${node.title}` : node.title;

      if (node.childrenList && node.childrenList.length > 0) {
        // Directory node — recurse
        entries.push(...this.collectLeafDocs(node.childrenList, currentPath));
      } else {
        // Leaf node — this is a document
        const updateTimestamp = parseInt(node.updateTime, 10);
        let lastUpdated: string | undefined;
        if (updateTimestamp > 0) {
          // updateTime is unix seconds
          const date = new Date(updateTimestamp * 1000);
          if (!isNaN(date.getTime())) {
            lastUpdated = date.toISOString().split('T')[0];
          }
        }

        entries.push({
          path: currentPath,
          title: node.title,
          docType: 'api_reference',
          sourceUrl: `${BASE_URL}${node.url}`,
          platformId: node.docId,
          lastUpdated,
        });
      }
    }

    return entries;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[wechat-pay] 获取文档目录树...');

    await this.throttle();
    const resp = await this.client.get(`/doc/v3/merchant/${ENTRY_DOC_ID}`);
    const ctx = this.extractPageContext(resp.data as string);

    if (!ctx) {
      throw new Error('无法从页面提取 vike_pageContext');
    }

    const data = ctx.data as Record<string, unknown> | undefined;
    const menuData = data?.menuData as MenuNode[] | undefined;

    if (!menuData || menuData.length === 0) {
      throw new Error('menuData 为空');
    }

    const entries = this.collectLeafDocs(menuData, '');

    // Log category stats
    const categories = new Map<string, number>();
    for (const entry of entries) {
      const topLevel = entry.path.split('/')[0];
      categories.set(topLevel, (categories.get(topLevel) || 0) + 1);
    }
    for (const [cat, count] of categories) {
      console.log(`[wechat-pay] ${cat}: ${count} 篇`);
    }

    console.log(`[wechat-pay] 目录加载完成: ${entries.length} 篇文档`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const docId = entry.platformId;
    if (!docId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    await this.throttle();
    const resp = await this.client.get(`/doc/v3/merchant/${docId}`);
    const ctx = this.extractPageContext(resp.data as string);

    if (!ctx) {
      throw new Error(`无法从文档 ${docId} 提取 pageContext`);
    }

    const data = ctx.data as Record<string, unknown> | undefined;
    const iwikiData = data?.iwikiData as string | undefined;

    if (!iwikiData) {
      throw new Error(`文档 ${docId} 缺少 iwikiData`);
    }

    // Build Markdown
    const sections: string[] = [];

    // Title
    sections.push(`# ${entry.title}\n`);

    // Path breadcrumb
    sections.push(`路径：${entry.path}\n`);

    // Main content (HTML → Markdown)
    const md = htmlToMarkdown(iwikiData);
    if (md) {
      sections.push(md);
    }

    const markdown = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (entry.lastUpdated) {
      metadata.lastUpdated = entry.lastUpdated;
    }

    return {
      markdown,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    // 微信支付文档无增量 API，全量拉取
    return this.fetchCatalog();
  }
}
