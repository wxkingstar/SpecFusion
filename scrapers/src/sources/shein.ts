import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { decode } from 'html-entities';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://open.sheincorp.com';
const API_BASE = `${BASE_URL}/api`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms） */
const REQUEST_DELAY = 300;

/** 错误码分页大小 */
const ERROR_PAGE_SIZE = 100;

// ─── API response interfaces ────────────────────────────────────────────────

interface SheinResponse<T> {
  code: string;
  msg: string;
  info: T;
}

interface SheinCategory {
  id: number;
  categoryName: string;
  categoryDesc: string;
  docType: { key: number; value: string; data: string };
  apiDocVoList: SheinApiDocVo[];
}

interface SheinApiDocVo {
  id: number;
  openPath: string;
  title: string;
  docName: string;
  userDocName: string;
  method: string;
  docType: { key: number; value: string; data: string };
  isEvaluate: number;
  categoryId: number;
}

interface SheinDetailResponse {
  mode: number[];
  modeNameList: string[];
  apiPublishDocVo: {
    id: number;
    openPath: string;
    title: string;
    userDocName: string;
    method: string;
    changeContent: string;
    docType: { key: number; value: string; data: string };
    version: number;
    updateTime: string;
    categoryId: number;
    qpsContent: string;
  };
  apiPublishDocDetailVo: {
    id: number;
    openPath: string;
    title: string;
    userDocName: string;
    method: string;
    description: string;
    docType: { key: number; value: string; data: string };
    updateTime: string;
    queryStrings: string;
    requestExample: string;
    responseExample: string;
    requestHeader: string;
    requestBody: string;
    responseHeader: string | null;
    responseBody: string;
    apiPublishDocExampleDetailVo: Array<{
      sceneName: string;
      requestExample: string;
      responseExample: string;
      sort: number;
    }>;
  };
}

interface SheinErrorItem {
  id: number;
  openPath: string;
  errorCode: string;
  errorMsg: string;
  errorMsgCn: string;
  solution: string;
}

interface SheinErrorListResponse {
  data: SheinErrorItem[];
  total: number;
}

/** JSON 参数树中的节点 */
interface ParamNode {
  props: {
    type?: string;
    name?: string;
    description?: string;
    required?: boolean;
    label?: string;
  };
  children?: ParamNode[];
}

// ─── Utility helpers ────────────────────────────────────────────────────────


function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 从 HTML 字符串中提取纯文本（用于参数描述） */
function stripHtml(html: string): string {
  if (!html) return '';
  const $ = load(html);
  return decode($.root().text()).trim();
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

  let md = decode($.root().text());
  md = stripHtmlComments(md);
  md = md.replace(/<[^>]+>/g, '');
  md = collapseBlankLines(md);
  md = md.trim();

  return md;
}

// ─── JSON param tree → Markdown table ───────────────────────────────────────

function paramTreeToTable(jsonStr: string, depth = 0): string {
  if (!jsonStr) return '';

  let root: ParamNode;
  try {
    root = JSON.parse(jsonStr);
  } catch {
    return '';
  }

  const children = root.children;
  if (!children || children.length === 0) return '';

  const rows: string[] = [];
  rows.push('| 参数名称 | 数据类型 | 是否必须 | 描述 |');
  rows.push('| --- | --- | --- | --- |');

  function walkNode(node: ParamNode, level: number): void {
    const p = node.props;
    if (!p.name) return;

    const indent = level > 0 ? '&nbsp;'.repeat(level * 2) + '└ ' : '';
    const name = `${indent}${p.name}`;
    const type = p.type || '';
    const required = p.required ? '是' : '否';
    const desc = escapeCell(stripHtml(p.description || p.label || ''));

    rows.push(`| ${escapeCell(name)} | ${type} | ${required} | ${desc} |`);

    if (node.children) {
      for (const child of node.children) {
        walkNode(child, level + 1);
      }
    }
  }

  for (const child of children) {
    walkNode(child, depth);
  }

  return rows.join('\n');
}

// ─── SheinSource class ─────────────────────────────────────────────────────

export class SheinSource implements DocSource {
  id = 'shein';
  name = 'SHEIN开放平台';

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
        Referer: `${BASE_URL}/documents/apidoc/detail/3001520`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 50 === 0) {
      console.log(`[shein] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  /** 获取某类文档的分类目录（categoryType=1 为 API 文档，2 为 Webhook 消息文档） */
  private async fetchCategoryList(categoryType: number): Promise<SheinCategory[]> {
    await this.throttle();
    const resp = await this.client.get<SheinResponse<SheinCategory[]>>(
      '/api/apiDoc/queryAllApiDocCategoryList',
      { params: { categoryType } },
    );
    if (resp.data.code !== '0') {
      throw new Error(`获取分类列表失败 (type=${categoryType}): ${resp.data.msg}`);
    }
    return resp.data.info;
  }

  /** 获取单篇文档详情 */
  private async fetchDetail(docId: number): Promise<SheinDetailResponse> {
    await this.throttle();
    const resp = await this.client.get<SheinResponse<SheinDetailResponse>>(
      '/api/apiDoc/queryApiPublishDocDetailInfoById',
      { params: { id: docId, isLatest: true } },
    );
    if (resp.data.code !== '0') {
      throw new Error(`获取文档 ${docId} 详情失败: ${resp.data.msg}`);
    }
    return resp.data.info;
  }

  /** 获取文档的错误码列表 */
  private async fetchErrorList(openPath: string): Promise<SheinErrorItem[]> {
    await this.throttle();
    try {
      const resp = await this.client.post<SheinResponse<SheinErrorListResponse>>(
        '/api/apiDoc/error/list',
        { openPath, page: 1, pageSize: ERROR_PAGE_SIZE, language: 'zh-cn' },
      );
      if (resp.data.code !== '0') return [];
      return resp.data.info?.data || [];
    } catch {
      return [];
    }
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    const entries: DocEntry[] = [];

    for (const categoryType of [1, 2]) {
      const typeName = categoryType === 1 ? 'API文档' : 'Webhook消息文档';
      console.log(`[shein] 获取${typeName}分类列表...`);
      const categories = await this.fetchCategoryList(categoryType);
      console.log(`[shein] ${typeName}: ${categories.length} 个分类`);

      for (const cat of categories) {
        this.categoryMap.set(cat.id, cat.categoryName);

        for (const doc of cat.apiDocVoList) {
          const docTypeName = categoryType === 1 ? 'api_reference' : 'event';
          const urlPath = categoryType === 1 ? 'apidoc' : 'msgdoc';

          entries.push({
            path: `${cat.categoryName}/${doc.userDocName}`,
            title: doc.userDocName,
            apiPath: doc.openPath,
            docType: docTypeName,
            sourceUrl: `${BASE_URL}/documents/${urlPath}/detail/${doc.id}`,
            platformId: String(doc.id),
          });
        }

        console.log(
          `[shein] ${cat.categoryName}: ${cat.apiDocVoList.length} 篇`,
        );
      }
    }

    console.log(`[shein] 目录加载完成: ${entries.length} 篇文档`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const docId = Number(entry.platformId);
    if (!docId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    const detail = await this.fetchDetail(docId);
    const docVo = detail.apiPublishDocVo;
    const docDetail = detail.apiPublishDocDetailVo;

    // ── Build Markdown ──────────────────────────────────────────────
    const sections: string[] = [];

    // Title
    sections.push(`# ${docDetail.userDocName}\n`);

    // Method + Path
    sections.push(`**${docVo.method}** \`${docDetail.openPath}\`\n`);

    // Category
    const catName = this.categoryMap.get(docVo.categoryId) || '';
    if (catName) {
      sections.push(`分类：${catName}\n`);
    }

    // Supported modes
    if (detail.modeNameList && detail.modeNameList.length > 0) {
      sections.push(`适用模式：${detail.modeNameList.join('、')}\n`);
    }

    // Rate limit
    if (docVo.qpsContent) {
      sections.push(`限流：${docVo.qpsContent}次/秒\n`);
    }

    // Description
    if (docDetail.description) {
      const descMd = htmlToMarkdown(docDetail.description);
      if (descMd) {
        sections.push(`## 接口描述\n\n${descMd}\n`);
      }
    }

    // Request header params
    if (docDetail.requestHeader) {
      const table = paramTreeToTable(docDetail.requestHeader);
      if (table) {
        sections.push(`## 请求参数（请求头）\n\n${table}\n`);
      }
    }

    // Query string params
    if (docDetail.queryStrings) {
      const table = paramTreeToTable(docDetail.queryStrings);
      if (table) {
        sections.push(`## 请求参数（Query）\n\n${table}\n`);
      }
    }

    // Request body params
    if (docDetail.requestBody) {
      const table = paramTreeToTable(docDetail.requestBody);
      if (table) {
        sections.push(`## 请求参数（请求体）\n\n${table}\n`);
      }
    }

    // Response body params
    if (docDetail.responseBody) {
      const table = paramTreeToTable(docDetail.responseBody);
      if (table) {
        sections.push(`## 返回参数（响应体）\n\n${table}\n`);
      }
    }

    // Request/Response examples
    const examples = docDetail.apiPublishDocExampleDetailVo || [];
    if (examples.length > 0) {
      sections.push('## 请求返回示例\n');
      for (const ex of examples) {
        if (examples.length > 1) {
          sections.push(`### ${ex.sceneName}\n`);
        }
        if (ex.requestExample) {
          sections.push(`**请求示例**\n\n${htmlToMarkdown(ex.requestExample)}\n`);
        }
        if (ex.responseExample) {
          sections.push(`**返回示例**\n\n${htmlToMarkdown(ex.responseExample)}\n`);
        }
      }
    } else {
      // Fallback to top-level examples
      if (docDetail.requestExample) {
        sections.push(`## 请求示例\n\n${htmlToMarkdown(docDetail.requestExample)}\n`);
      }
      if (docDetail.responseExample) {
        sections.push(`## 返回示例\n\n${htmlToMarkdown(docDetail.responseExample)}\n`);
      }
    }

    // Error codes
    const errors = await this.fetchErrorList(docDetail.openPath);
    const errorCodes: Array<{ code: string; message?: string; description?: string }> = [];

    if (errors.length > 0) {
      sections.push('## 业务错误码\n');
      sections.push('| 错误码 | 错误信息 | 解决方案 |');
      sections.push('| --- | --- | --- |');
      for (const err of errors) {
        sections.push(
          `| ${escapeCell(err.errorCode)} | ${escapeCell(err.errorMsgCn || err.errorMsg)} | ${escapeCell(err.solution)} |`,
        );
        errorCodes.push({
          code: err.errorCode,
          message: err.errorMsgCn || err.errorMsg,
          description: err.solution,
        });
      }
      sections.push('');
    }

    const markdown = sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Tokenize for FTS
    const metadata: Record<string, unknown> = {
      tokenizedTitle: tokenize(entry.title),
      tokenizedContent: tokenize(markdown),
    };

    if (docVo.updateTime) {
      // Format: "2025-12-26 14:35:50" → "2025-12-26"
      metadata.lastUpdated = docVo.updateTime.split(' ')[0];
    }

    return {
      markdown,
      apiPath: docDetail.openPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
