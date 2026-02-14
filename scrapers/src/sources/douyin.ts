import axios, { type AxiosInstance } from 'axios';
import { tokenize } from '../utils/tokenizer.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://op.jinritemai.com';
const API_PREFIX = '/doc/external/open';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** API文档 根目录 ID */
const ROOT_DIR_ID = 3;
/** 请求间隔（ms） */
const REQUEST_DELAY = 500;
/** 每页文章数，设置足够大以一次获取全部 */
const PAGE_SIZE = 200;

// ─── API response interfaces ────────────────────────────────────────────────

interface DouyinResponse<T> {
  code: number;
  message?: string;
  data: T;
}

interface DirTreeData {
  CustomerError: { ErrCode: number; ErrMsg: string };
  dirName: string;
  dirs: DirItem[];
}

interface DirItem {
  id: number;
  name: string;
  order: number;
  hidden: boolean;
  total: number;
  articles: unknown[];
  subDirs: unknown[];
}

interface ArticleListData {
  CustomerError: { ErrCode: number; ErrMsg: string };
  articles: ArticleListItem[];
  total: number;
}

interface ArticleListItem {
  id: number;
  name?: string;
  title?: string;
  description?: string;
  dirId: number;
  dirName: string;
  updateTime?: number;
  pv?: number;
  contentType?: number;
}

interface ArticleDetailData {
  CustomerError: { ErrCode: number; ErrMsg: string };
  article: {
    content: string;
    info: ArticleInfo;
  };
  RelevanceFAQs?: unknown[];
}

interface ArticleInfo {
  id: number;
  title: string;
  description?: string;
  dirId: number;
  dirName: string;
  updateTime?: number;
  apiChargeType?: number;
  apiLimitLevel?: number;
  apiLimitValue?: number;
  authSubjectIdList?: string[];
  auths?: Array<{
    groupName: string;
    packageName: string;
  }>;
}

/** content JSON 中的参数定义 */
interface DouyinParam {
  requestName?: string;
  responseName?: string;
  fromName?: string;
  toName?: string;
  mustNeed?: boolean;
  type?: number;
  style?: number;
  example?: string;
  description?: string;
  cipherTextType?: number;
  timeConvert?: number;
  securityLevel?: number;
  tagId?: number;
  children?: DouyinParam[];
}

interface DouyinContentJson {
  request?: {
    publicParam?: DouyinParam[];
    requestParam?: DouyinParam[];
    param?: DouyinParam[];
  };
  response?: {
    responseData?: DouyinParam[];
  };
  demo?: {
    requestDemo?: Record<string, string>;
    responseDemo?: {
      responseSuccess?: string;
      responseError?: string;
    };
  };
  error?: {
    errCodeList?: Array<{
      code: number;
      msg: string;
      subCode?: string;
      subMsg?: string;
      solution?: string;
    }>;
  };
}

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 参数 type 数字转可读类型名 */
function paramTypeName(type?: number): string {
  switch (type) {
    case 1: return 'Number';
    case 2: return 'String';
    case 3: return 'Boolean';
    case 4: return 'Object';
    case 5: return 'Array';
    default: return type != null ? `Type(${type})` : '';
  }
}

// ─── JSON → Markdown conversion ─────────────────────────────────────────────

function renderParamTable(params: DouyinParam[], title: string, isResponse = false): string {
  if (!params || params.length === 0) return '';

  const lines: string[] = [];
  lines.push(`## ${title}\n`);

  if (isResponse) {
    lines.push('| 名称 | 类型 | 示例值 | 描述 |');
    lines.push('|------|------|--------|------|');
  } else {
    lines.push('| 名称 | 类型 | 必填 | 示例值 | 描述 |');
    lines.push('|------|------|------|--------|------|');
  }

  function renderRow(param: DouyinParam, indent: number): void {
    const prefix = indent > 0 ? '&nbsp;'.repeat(indent * 2) + '└ ' : '';
    const name = param.requestName || param.responseName || '';
    const displayName = `${prefix}${name}`;
    const type = paramTypeName(param.type);
    const example = escapeCell(param.example || '');
    const desc = escapeCell(param.description || '');

    if (isResponse) {
      lines.push(`| ${escapeCell(displayName)} | ${type} | ${example} | ${desc} |`);
    } else {
      const required = param.mustNeed ? '是' : '否';
      lines.push(`| ${escapeCell(displayName)} | ${type} | ${required} | ${example} | ${desc} |`);
    }

    if (param.children && param.children.length > 0) {
      for (const child of param.children) {
        renderRow(child, indent + 1);
      }
    }
  }

  for (const param of params) {
    renderRow(param, 0);
  }

  lines.push('');
  return lines.join('\n');
}

function renderErrorCodesTable(
  errCodes: NonNullable<DouyinContentJson['error']>['errCodeList'],
): string {
  if (!errCodes || errCodes.length === 0) return '';

  const lines: string[] = [];
  lines.push('## 错误码\n');
  lines.push('| 主返回码 | 描述 | 子返回码 | 子描述 | 解决方案 |');
  lines.push('|----------|------|----------|--------|----------|');

  for (const ec of errCodes) {
    lines.push(
      `| ${ec.code} | ${escapeCell(ec.msg || '')} | ${escapeCell(ec.subCode || '')} | ${escapeCell(ec.subMsg || '')} | ${escapeCell(ec.solution || '')} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function articleToMarkdown(info: ArticleInfo, content: DouyinContentJson): string {
  const sections: string[] = [];

  // Title
  sections.push(`# ${info.title}\n`);

  // Description
  if (info.description) {
    sections.push(`${info.description}\n`);
  }

  // Auth info
  if (info.authSubjectIdList && info.authSubjectIdList.length > 0) {
    sections.push(`授权主体：${info.authSubjectIdList.join('、')}\n`);
  }
  if (info.apiChargeType === 1) {
    sections.push('费用：免费API\n');
  }

  // Request - public params
  if (content.request?.publicParam && content.request.publicParam.length > 0) {
    sections.push(renderParamTable(content.request.publicParam, '公共参数'));
  }

  // Request params
  const requestParams = content.request?.requestParam || content.request?.param || [];
  if (requestParams.length > 0) {
    sections.push(renderParamTable(requestParams, '请求参数'));
  }

  // Request demo (curl)
  if (content.demo?.requestDemo) {
    const curlDemo = content.demo.requestDemo.curl || content.demo.requestDemo.python;
    if (curlDemo && typeof curlDemo === 'string') {
      const lang = content.demo.requestDemo.curl ? 'bash' : 'python';
      sections.push('## 请求示例\n');
      sections.push(`\`\`\`${lang}\n${curlDemo}\n\`\`\`\n`);
    }
  }

  // Response params
  if (content.response?.responseData && content.response.responseData.length > 0) {
    sections.push(renderParamTable(content.response.responseData, '响应参数', true));
  }

  // Response demo
  if (content.demo?.responseDemo?.responseSuccess) {
    sections.push('## 响应示例\n');
    const respStr =
      typeof content.demo.responseDemo.responseSuccess === 'string'
        ? content.demo.responseDemo.responseSuccess
        : JSON.stringify(content.demo.responseDemo.responseSuccess, null, 2);
    try {
      const formatted = JSON.stringify(JSON.parse(respStr), null, 2);
      sections.push(`\`\`\`json\n${formatted}\n\`\`\`\n`);
    } catch {
      sections.push(`\`\`\`json\n${respStr}\n\`\`\`\n`);
    }
  }

  // Error codes
  if (content.error?.errCodeList && content.error.errCodeList.length > 0) {
    sections.push(renderErrorCodesTable(content.error.errCodeList));
  }

  // Permission packages
  if (info.auths && info.auths.length > 0) {
    sections.push('## 权限要求\n');
    for (const auth of info.auths) {
      if (auth.groupName || auth.packageName) {
        sections.push(`- **${auth.groupName}** — ${auth.packageName}`);
      }
    }
    sections.push('');
  }

  // Rate limit
  if (info.apiLimitValue) {
    sections.push(`## 限流\n`);
    sections.push(`接口总限流频次：${info.apiLimitValue}次/秒\n`);
  }

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── DouyinSource class ─────────────────────────────────────────────────────

export class DouyinSource implements DocSource {
  id = 'douyin';
  name = '抖音电商开放平台';

  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${BASE_URL}/docs/api-docs`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 100 === 0) {
      console.log(`[douyin] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  /** 获取所有 API 分类 */
  private async fetchCategories(): Promise<DirItem[]> {
    const resp = await this.client.get<DouyinResponse<DirTreeData>>(
      `${API_PREFIX}/QueryDocDirTreeNew`,
      { params: { dirId: ROOT_DIR_ID } },
    );

    if (resp.data.code !== 0) {
      throw new Error(`获取目录树失败: code=${resp.data.code} ${resp.data.message || ''}`);
    }

    const dirs = resp.data.data.dirs;
    if (!dirs || dirs.length === 0) {
      throw new Error('目录树为空');
    }

    // 过滤隐藏分类
    return dirs.filter((d) => !d.hidden);
  }

  /** 获取某个分类下的所有文章 */
  private async fetchArticleList(dirId: number): Promise<ArticleListItem[]> {
    const resp = await this.client.get<DouyinResponse<ArticleListData>>(
      `${API_PREFIX}/queryDocArticleList`,
      { params: { dirId, pageNo: 1, pageSize: PAGE_SIZE } },
    );

    if (resp.data.code !== 0) {
      throw new Error(`获取文章列表失败 (dirId=${dirId}): code=${resp.data.code}`);
    }

    const { articles, total } = resp.data.data;

    // 如果总数超过 PAGE_SIZE，需要分页获取
    if (total > PAGE_SIZE) {
      console.log(`[douyin] 分类 dirId=${dirId} 文章数 ${total} 超过单页限制，分页获取...`);
      const allArticles = [...articles];
      let pageNo = 2;
      while (allArticles.length < total) {
        await this.throttle();
        const pageResp = await this.client.get<DouyinResponse<ArticleListData>>(
          `${API_PREFIX}/queryDocArticleList`,
          { params: { dirId, pageNo, pageSize: PAGE_SIZE } },
        );
        if (pageResp.data.code !== 0 || !pageResp.data.data.articles.length) break;
        allArticles.push(...pageResp.data.data.articles);
        pageNo++;
      }
      return allArticles;
    }

    return articles;
  }

  /** 获取单篇文章详情 */
  private async fetchArticleDetail(articleId: number): Promise<ArticleDetailData['article']> {
    const resp = await this.client.get<DouyinResponse<ArticleDetailData>>(
      `${API_PREFIX}/queryDocArticleDetail`,
      { params: { articleId } },
    );

    if (resp.data.code !== 0) {
      throw new Error(`获取文章详情失败 (articleId=${articleId}): code=${resp.data.code}`);
    }

    return resp.data.data.article;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[douyin] 获取 API 目录树...');
    const categories = await this.fetchCategories();
    console.log(`[douyin] 发现 ${categories.length} 个 API 分类`);

    const entries: DocEntry[] = [];

    for (const category of categories) {
      await this.throttle();

      try {
        const articles = await this.fetchArticleList(category.id);
        console.log(`[douyin] ${category.name} (dirId=${category.id}): ${articles.length} 个 API`);

        for (const article of articles) {
          const title = article.title || article.name || `article-${article.id}`;
          // title 通常是 "/order/getMCToken" 格式，去掉前导斜杠再拼接 path
          const pathSegment = title.replace(/^\/+/, '');
          entries.push({
            path: `${category.name}/${pathSegment}`,
            title,
            apiPath: title.startsWith('/') ? title : undefined,
            docType: 'api_reference',
            sourceUrl: `${BASE_URL}/docs/api-docs/${category.id}/${article.id}`,
            platformId: String(article.id),
            lastUpdated: article.updateTime
              ? new Date(article.updateTime * 1000).toISOString().split('T')[0]
              : undefined,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[douyin] 获取分类 ${category.name} 失败: ${msg}`);
      }
    }

    console.log(`[douyin] 目录加载完成: ${categories.length} 个分类, ${entries.length} 个 API`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const articleId = Number(entry.platformId);
    if (!articleId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    await this.throttle();

    const article = await this.fetchArticleDetail(articleId);
    const info = article.info;

    // Parse structured content JSON
    let content: DouyinContentJson = {};
    try {
      content = JSON.parse(article.content);
    } catch {
      console.warn(`[douyin] articleId=${articleId} content JSON 解析失败，使用空内容`);
    }

    const markdown = articleToMarkdown(info, content);

    // Extract error codes
    const errorCodes = content.error?.errCodeList
      ?.filter((ec) => ec.code !== 10000) // 排除 success
      .map((ec) => ({
        code: String(ec.subCode || ec.code),
        message: ec.subMsg || ec.msg,
        description: ec.solution,
      }));

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (info.updateTime) {
      const date = new Date(info.updateTime * 1000);
      if (!isNaN(date.getTime())) {
        metadata.lastUpdated = date.toISOString().split('T')[0];
      }
    }

    return {
      markdown,
      apiPath: info.title,
      errorCodes: errorCodes && errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
