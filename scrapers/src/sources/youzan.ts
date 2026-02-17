import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { decode } from 'html-entities';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://doc.youzanyun.com';
const API_BASE = `${BASE_URL}/api/new-doc`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms） */
const REQUEST_DELAY = 300;

/** 每页 API 条数（有赞 API 最多支持 100） */
const PAGE_SIZE = 100;

// ─── API response interfaces ────────────────────────────────────────────────

interface YouzanResponse<T> {
  code: number;
  msg: string;
  data: T;
}

interface YouzanCategory {
  groupId: number;
  name: string;
  alias: string;
  description: string;
  sequence: string;
}

interface YouzanListResult {
  items: YouzanListItem[];
  totalCount?: number;
}

interface YouzanListItem {
  docId: string; // e.g. "API-1290"
  extend: string; // JSON string
  businessLine: string[];
  hide: boolean;
  top: boolean;
}

interface YouzanListExtend {
  apiName: string; // e.g. "youzan.pay.courier.balance.query"
  metaId: string; // e.g. "1290"
  apiDesc: string;
  createTime: number;
  sequence: number;
}

interface YouzanDetail {
  id: number;
  title: string;
  content: string; // HTML
  catId: number;
  extend: string; // JSON string
  groupInfo: string;
  createTime: number;
  updateTime: number;
  remark: string;
  source: number;
  type: number;
  businessLine: string[];
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

// ─── YouzanSource class ─────────────────────────────────────────────────────

export class YouzanSource implements DocSource {
  id = 'youzan';
  name = '有赞开放平台';

  private client: AxiosInstance;
  private requestCount = 0;
  /** category id → name */
  private categoryMap = new Map<number, string>();

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${BASE_URL}/list/API/`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[youzan] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  /** 获取所有 API 分类 */
  private async fetchCategories(): Promise<YouzanCategory[]> {
    const resp = await this.client.get<YouzanResponse<YouzanCategory[]>>(
      '/resource/getDocGroupListBySource',
      { params: { keyword: '', docSource: 2 } },
    );
    if (resp.data.code !== 0) {
      throw new Error(`获取分类列表失败: ${resp.data.msg}`);
    }
    return resp.data.data;
  }

  /** 获取某分类下的所有 API 列表（分页） */
  private async fetchApiList(catId: number): Promise<YouzanListItem[]> {
    const allItems: YouzanListItem[] = [];
    let pageIndex = 1;

    while (true) {
      await this.throttle();
      const resp = await this.client.get<YouzanResponse<YouzanListResult>>(
        '/list-detail/show-list',
        {
          params: {
            catId,
            source: 2,
            keyword: '',
            pageSize: PAGE_SIZE,
            pageIndex,
          },
        },
      );
      if (resp.data.code !== 0) {
        throw new Error(`获取分类 ${catId} 文档列表失败: ${resp.data.msg}`);
      }

      const items = resp.data.data.items || [];
      allItems.push(...items);

      // 如果返回数量少于 PAGE_SIZE，说明没有更多了
      if (items.length < PAGE_SIZE) break;
      pageIndex++;
    }

    return allItems;
  }

  /** 获取单个 API 详情 */
  private async fetchDetail(metaId: string): Promise<YouzanDetail> {
    await this.throttle();
    const resp = await this.client.get<YouzanResponse<YouzanDetail>>(
      '/list-detail/show-detail',
      { params: { id: metaId, docSource: 2 } },
    );
    if (resp.data.code !== 0) {
      throw new Error(`获取 API ${metaId} 详情失败: ${resp.data.msg}`);
    }
    return resp.data.data;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[youzan] 获取 API 分类列表...');
    const categories = await this.fetchCategories();
    console.log(`[youzan] 发现 ${categories.length} 个 API 分类`);

    for (const cat of categories) {
      this.categoryMap.set(cat.groupId, cat.name);
    }

    const entries: DocEntry[] = [];

    for (const category of categories) {
      try {
        const items = await this.fetchApiList(category.groupId);
        const visibleItems = items.filter((item) => !item.hide);
        console.log(
          `[youzan] ${category.name} (groupId=${category.groupId}): ${visibleItems.length} 个 API`,
        );

        for (const item of visibleItems) {
          try {
            const ext: YouzanListExtend = JSON.parse(item.extend);
            entries.push({
              path: `${category.name}/${ext.apiName}`,
              title: `${ext.apiName}（${ext.apiDesc}）`,
              apiPath: ext.apiName,
              docType: 'api_reference',
              sourceUrl: `${BASE_URL}/detail/API/0/${ext.metaId}`,
              platformId: ext.metaId,
              lastUpdated: ext.createTime
                ? new Date(ext.createTime).toISOString().split('T')[0]
                : undefined,
            });
          } catch {
            console.warn(`[youzan] 解析 extend 失败: ${item.docId}`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[youzan] 获取分类 ${category.name} 失败: ${msg}`);
      }
    }

    console.log(`[youzan] 目录加载完成: ${categories.length} 个分类, ${entries.length} 个 API`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const metaId = entry.platformId;
    if (!metaId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    const detail = await this.fetchDetail(metaId);

    // Build Markdown from detail
    const sections: string[] = [];

    // Title
    sections.push(`# ${detail.title}\n`);

    // Category
    const catName = this.categoryMap.get(detail.catId) || `分类${detail.catId}`;
    sections.push(`分类：${catName}\n`);

    // Business lines (may be array of strings, or array with one JSON-encoded string)
    if (detail.businessLine && detail.businessLine.length > 0) {
      let lines = detail.businessLine;
      if (lines.length === 1 && typeof lines[0] === 'string' && lines[0].startsWith('[')) {
        try {
          lines = JSON.parse(lines[0]) as string[];
        } catch { /* keep original */ }
      }
      sections.push(`适用业务：${lines.join('、')}\n`);
    }

    // Remark (API description from extend)
    if (detail.remark) {
      sections.push(`${detail.remark}\n`);
    }

    // Main content (HTML → Markdown)
    if (detail.content) {
      const md = htmlToMarkdown(detail.content);
      if (md) {
        sections.push(md);
      }
    }

    const markdown = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (detail.updateTime) {
      const date = new Date(detail.updateTime);
      if (!isNaN(date.getTime())) {
        metadata.lastUpdated = date.toISOString().split('T')[0];
      }
    }

    return {
      markdown,
      apiPath: detail.title, // API name like "youzan.pay.courier.balance.query"
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
