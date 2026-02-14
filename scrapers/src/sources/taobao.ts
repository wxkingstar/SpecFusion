import axios, { type AxiosInstance } from 'axios';
import { CookieJar } from 'tough-cookie';
import { tokenize } from '../utils/tokenizer.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://open.taobao.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 基础请求间隔（ms）— 设置较大以避免触发反爬 */
const BASE_DELAY = 2000;
/** 请求间隔随机抖动范围（ms） */
const JITTER = 1000;
/** 每批文档数量，达到后主动休息 */
const BATCH_REST_INTERVAL = 100;
/** 批次间休息时间（ms） */
const BATCH_REST_DURATION = 60_000;
/** 触发反爬后冷却时间（ms）— 5 分钟 */
const ANTI_BOT_COOLDOWN = 5 * 60 * 1000;
/** Session 有效期（15 分钟），超过自动刷新 */
const SESSION_TTL_MS = 15 * 60 * 1000;

// ─── Taobao API response interfaces ────────────────────────────────────────

interface TaobaoApiResponse<T> {
  code: string;
  data: T;
  success: boolean;
  msg?: string;
  /** x5sec 反爬返回的字段 */
  ret?: string[];
}

interface CatalogData {
  id: number;
  name: string;
  treeCategories: CatalogTreeRoot[];
}

interface CatalogTreeRoot {
  catelogTrees: CatalogCategory[];
}

interface CatalogCategory {
  id: number;
  name: string;
  catelogList: CatalogItem[];
}

interface CatalogItem {
  docId: number;
  docType: number;
  name: string;
  subName: string;
  id: number;
  pid: number;
  treeId: number | null;
}

interface TaobaoParam {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  demoValue?: string;
  maxLength?: number;
  subParams?: TaobaoParam[];
}

interface TaobaoErrorCode {
  errorCode: string;
  errorMsg: string;
  solution?: string;
}

interface TaobaoEnvConfig {
  name: string;
  httpUrl: string;
  httpsUrl: string;
}

interface TaobaoDocData {
  name: string;
  apiChineseName: string;
  description?: string;
  labels?: Array<{ displayName: string; key?: string; tips?: string }>;
  requestParams?: TaobaoParam[];
  responseParams?: TaobaoParam[];
  publicParams?: TaobaoParam[];
  publicResponseParams?: TaobaoParam[];
  errorCodes?: TaobaoErrorCode[];
  envConfigs?: TaobaoEnvConfig[];
  rspSampleJson?: string;
  rspSampleSimplifyJson?: string;
  apiErrDemoJson?: string;
  gmtModified?: number;
  sdkDemos?: Array<{ language: string; demo: string }>;
  applyScopes?: Array<{ scopeName: string; scopeDesc: string }>;
}

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Random delay with jitter */
function randomDelay(base: number, jitter: number): Promise<void> {
  const ms = base + Math.floor(Math.random() * jitter);
  return delay(ms);
}

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Strip HTML tags from description text, converting <br> to newlines */
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
    .replace(/<\/?(div|span|p|strong|em|b|i)[^>]*>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 检测 x5sec 反爬响应 — 涵盖多种响应格式 */
function isAntiBotResponse(data: unknown): boolean {
  // null / undefined — 非正常 JSON 响应
  if (data == null) return true;

  // HTML 挑战页面 (包括空字符串)
  if (typeof data === 'string') return true;

  // 非对象类型 (number, boolean 等) — 不是正常 API 响应
  if (typeof data !== 'object') return true;

  const d = data as Record<string, unknown>;

  // x5sec JSON 格式: {ret: ["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::..."], data: {url: "..."}}
  if (Array.isArray(d.ret)) {
    const hasAntiBot = d.ret.some(
      (r: unknown) =>
        typeof r === 'string' &&
        (r.includes('RGV587_ERROR') || r.includes('FAIL_SYS_USER_VALIDATE')),
    );
    if (hasAntiBot) return true;
  }

  // 有 ret 字段但 success 不是 boolean — 可能是变体反爬响应
  if ('ret' in d && typeof d.success !== 'boolean') return true;

  // 包含 punish / x5sec 相关 URL
  if (typeof d.url === 'string' && (d.url.includes('punish') || d.url.includes('x5sec'))) {
    return true;
  }

  // action=captcha — Playwright context.request 曾遇到的格式
  if (d.action === 'captcha') return true;

  return false;
}

// ─── JSON → Markdown conversion ─────────────────────────────────────────────

function renderParamTable(params: TaobaoParam[], title: string): string {
  if (!params || params.length === 0) return '';

  const lines: string[] = [];
  lines.push(`## ${title}\n`);
  lines.push('| 名称 | 类型 | 必填 | 描述 |');
  lines.push('|------|------|------|------|');

  function renderRow(param: TaobaoParam, indent: number): void {
    const prefix = indent > 0 ? '&nbsp;'.repeat(indent * 2) + '└ ' : '';
    const name = `${prefix}${param.name}`;
    const type = param.type || '';
    const required = param.required ? '是' : '否';
    const desc = escapeCell(stripHtml(param.description || ''));
    lines.push(`| ${escapeCell(name)} | ${type} | ${required} | ${desc} |`);

    if (param.subParams && param.subParams.length > 0) {
      for (const sub of param.subParams) {
        renderRow(sub, indent + 1);
      }
    }
  }

  for (const param of params) {
    renderRow(param, 0);
  }

  lines.push('');
  return lines.join('\n');
}

function renderErrorCodesTable(errorCodes: TaobaoErrorCode[]): string {
  if (!errorCodes || errorCodes.length === 0) return '';

  const lines: string[] = [];
  lines.push('## 错误码\n');
  lines.push('| 错误码 | 错误信息 | 解决方案 |');
  lines.push('|--------|----------|----------|');

  for (const ec of errorCodes) {
    lines.push(
      `| ${escapeCell(ec.errorCode)} | ${escapeCell(ec.errorMsg)} | ${escapeCell(ec.solution || '')} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function docToMarkdown(doc: TaobaoDocData): string {
  const sections: string[] = [];

  sections.push(`# ${doc.name}\n`);

  if (doc.apiChineseName) {
    sections.push(`**${doc.apiChineseName}**\n`);
  }
  if (doc.description) {
    sections.push(`${stripHtml(doc.description)}\n`);
  }

  if (doc.labels && doc.labels.length > 0) {
    const labelNames = doc.labels.map((l) => (typeof l === 'string' ? l : l.displayName)).filter(Boolean);
    if (labelNames.length > 0) {
      sections.push(`标签：${labelNames.join(', ')}\n`);
    }
  }

  if (doc.envConfigs && doc.envConfigs.length > 0) {
    sections.push('## 请求地址\n');
    sections.push('| 环境 | HTTP地址 | HTTPS地址 |');
    sections.push('|------|----------|-----------|');
    for (const env of doc.envConfigs) {
      sections.push(
        `| ${escapeCell(env.name)} | ${escapeCell(env.httpUrl)} | ${escapeCell(env.httpsUrl)} |`,
      );
    }
    sections.push('');
  }

  if (doc.publicParams && doc.publicParams.length > 0) {
    sections.push(renderParamTable(doc.publicParams, '公共请求参数'));
  }
  if (doc.requestParams && doc.requestParams.length > 0) {
    sections.push(renderParamTable(doc.requestParams, '请求参数'));
  }
  if (doc.publicResponseParams && doc.publicResponseParams.length > 0) {
    sections.push(renderParamTable(doc.publicResponseParams, '公共响应参数'));
  }
  if (doc.responseParams && doc.responseParams.length > 0) {
    sections.push(renderParamTable(doc.responseParams, '响应参数'));
  }

  if (doc.rspSampleJson) {
    sections.push('## 响应示例\n');
    try {
      const formatted = JSON.stringify(JSON.parse(doc.rspSampleJson), null, 2);
      sections.push('```json\n' + formatted + '\n```\n');
    } catch {
      sections.push('```json\n' + doc.rspSampleJson + '\n```\n');
    }
  }

  if (doc.apiErrDemoJson) {
    sections.push('## 异常示例\n');
    try {
      const formatted = JSON.stringify(JSON.parse(doc.apiErrDemoJson), null, 2);
      sections.push('```json\n' + formatted + '\n```\n');
    } catch {
      sections.push('```json\n' + doc.apiErrDemoJson + '\n```\n');
    }
  }

  if (doc.errorCodes && doc.errorCodes.length > 0) {
    sections.push(renderErrorCodesTable(doc.errorCodes));
  }

  if (doc.applyScopes && doc.applyScopes.length > 0) {
    sections.push('## 权限要求\n');
    for (const scope of doc.applyScopes) {
      sections.push(`- **${scope.scopeName}**：${scope.scopeDesc || ''}`);
    }
    sections.push('');
  }

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── TaobaoSource class ─────────────────────────────────────────────────────

export class TaobaoSource implements DocSource {
  id = 'taobao';
  name = '淘宝开放平台';

  private jar: CookieJar;
  private client: AxiosInstance;
  private tbToken = '';
  private requestCount = 0;
  private sessionInitAt = 0;
  private sessionRefreshPromise: Promise<void> | null = null;

  constructor() {
    this.jar = new CookieJar(undefined, { looseMode: true });
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${BASE_URL}/api.htm?docId=285&docType=2`,
      },
      timeout: 30_000,
    });

    // Intercept responses to store cookies
    this.client.interceptors.response.use((resp) => {
      const setCookies = resp.headers['set-cookie'];
      if (setCookies) {
        const url = resp.config.baseURL || BASE_URL;
        for (const sc of setCookies) {
          try {
            this.jar.setCookieSync(sc, url);
          } catch {
            // Ignore cross-domain cookies
          }
        }
      }
      return resp;
    });

    // Intercept requests to attach cookies
    this.client.interceptors.request.use(async (config) => {
      const url = (config.baseURL || BASE_URL) + (config.url || '');
      const cookieStr = await this.jar.getCookieString(url);
      if (cookieStr) {
        config.headers.set('Cookie', cookieStr);
      }
      return config;
    });
  }

  // ─── Session management ────────────────────────────────────────────────

  private async initSession(): Promise<void> {
    console.log('[taobao] 初始化会话，获取 _tb_token_...');

    const resp = await this.client.get('/api.htm?docId=285&docType=2', {
      headers: { Accept: 'text/html,*/*' },
      maxRedirects: 10,
    });

    const html = typeof resp.data === 'string' ? resp.data : '';

    // Extract _tb_token_ from hidden input
    const patterns = [
      /name=["']_tb_token_["'][^>]*value=["']([^"']+)["']/,
      /value=["']([^"']+)["'][^>]*name=["']_tb_token_["']/,
      /_tb_token_["']\s*:\s*["']([^"']+)["']/,
    ];

    this.tbToken = '';
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        this.tbToken = match[1];
        break;
      }
    }

    // Fallback: extract from cookie
    if (!this.tbToken) {
      const cookies = await this.jar.getCookies(BASE_URL);
      const tokenCookie = cookies.find((c) => c.key === '_tb_token_');
      if (tokenCookie) {
        this.tbToken = tokenCookie.value;
      }
    }

    if (!this.tbToken) {
      // Check if we got an anti-bot page
      if (html.includes('x5secdata') || html.includes('punish')) {
        throw new Error('initSession 触发反爬（x5sec CAPTCHA），请稍后重试');
      }
      throw new Error('无法获取 _tb_token_');
    }

    this.sessionInitAt = Date.now();

    const cookies = await this.jar.getCookies(BASE_URL);
    console.log(
      `[taobao] 会话初始化成功，token: ${this.tbToken.substring(0, 6)}...，cookies: ${cookies.map((c) => c.key).join(', ')}`,
    );
  }

  private async refreshSession(): Promise<void> {
    if (this.sessionRefreshPromise) {
      return this.sessionRefreshPromise;
    }
    this.sessionRefreshPromise = this.initSession().finally(() => {
      this.sessionRefreshPromise = null;
    });
    return this.sessionRefreshPromise;
  }

  private async ensureSession(): Promise<void> {
    const elapsed = Date.now() - this.sessionInitAt;
    if (elapsed > SESSION_TTL_MS) {
      console.log(`[taobao] Session 已过 ${(elapsed / 60000).toFixed(1)} 分钟，自动刷新...`);
      await this.refreshSession();
    }
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;

    // Periodic rest to avoid triggering anti-bot
    if (this.requestCount > 0 && this.requestCount % BATCH_REST_INTERVAL === 0) {
      console.log(
        `[taobao] 已处理 ${this.requestCount} 个请求，主动休息 ${BATCH_REST_DURATION / 1000}s...`,
      );
      await delay(BATCH_REST_DURATION);
    }

    await randomDelay(BASE_DELAY, JITTER);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  private async fetchCatalogTree(): Promise<CatalogCategory[]> {
    const resp = await this.client.get('/handler/document/getApiCatelogConfig.json', {
      params: { scopeId: '', _tb_token_: this.tbToken },
    });

    if (isAntiBotResponse(resp.data)) {
      throw new Error('获取目录时触发反爬（x5sec），请稍后重试');
    }

    const data = resp.data as TaobaoApiResponse<CatalogData>;

    if (!data.success) {
      throw new Error(`获取目录失败: ${data.msg || data.code}`);
    }

    const treeCategories = data.data?.treeCategories;
    if (!treeCategories || treeCategories.length === 0) {
      throw new Error('目录树为空');
    }

    return treeCategories[0].catelogTrees;
  }

  private async fetchDocument(
    docId: number,
    docType: number,
    attempt = 0,
  ): Promise<TaobaoDocData> {
    await this.ensureSession();

    try {
      const resp = await this.client.get('/handler/document/getDocument.json', {
        params: {
          isEn: false,
          docId,
          docType,
          _tb_token_: this.tbToken,
        },
      });

      const raw = resp.data;

      // Robust anti-bot detection: normal response must be a JSON object with boolean success
      if (isAntiBotResponse(raw)) {
        // Log the actual response for diagnostics (first occurrence only)
        if (attempt === 0) {
          const preview =
            typeof raw === 'string'
              ? raw.substring(0, 120)
              : JSON.stringify(raw).substring(0, 120);
          console.warn(
            `[taobao] docId=${docId} 反爬响应 (type=${typeof raw}): ${preview}`,
          );
        }
        if (attempt < 2) {
          const cooldown = attempt === 0 ? ANTI_BOT_COOLDOWN : ANTI_BOT_COOLDOWN * 2;
          console.warn(
            `[taobao] docId=${docId} 触发反爬（x5sec），冷却 ${cooldown / 60000} 分钟后重试 (attempt ${attempt + 1})...`,
          );
          await delay(cooldown);
          await this.refreshSession();
          return this.fetchDocument(docId, docType, attempt + 1);
        }
        throw new Error(`获取文档失败 (docId=${docId}): 反爬保护持续触发，请稍后重试`);
      }

      const data = raw as TaobaoApiResponse<TaobaoDocData>;

      if (!data.success) {
        const msg = data.msg || data.code || 'unknown error';
        // Log full response for diagnostics on first attempt
        if (attempt === 0) {
          console.warn(
            `[taobao] docId=${docId} success=false (resp keys=${Object.keys(data).join(',')}, msg=${JSON.stringify(data.msg)}, code=${JSON.stringify(data.code)})`,
          );
        }
        if (attempt < 2) {
          // Add delay before retry to avoid rapid-fire requests
          await delay(BASE_DELAY);
          await this.refreshSession();
          return this.fetchDocument(docId, docType, attempt + 1);
        }
        throw new Error(`获取文档失败 (docId=${docId}): ${msg}`);
      }

      if (!data.data || !data.data.name) {
        throw new Error(`文档数据为空 (docId=${docId})，可能已下架`);
      }

      return data.data;
    } catch (error: any) {
      const status = error?.response?.status;
      // Log caught errors for diagnostics
      if (attempt === 0 && error?.response) {
        const respData = error.response.data;
        const preview =
          typeof respData === 'string'
            ? respData.substring(0, 120)
            : JSON.stringify(respData)?.substring(0, 120);
        console.warn(
          `[taobao] docId=${docId} HTTP ${status} error (type=${typeof respData}): ${preview}`,
        );
      }
      if ((status === 429 || status === 503) && attempt < 3) {
        const waitMs = ANTI_BOT_COOLDOWN;
        console.warn(`[taobao] ${status} rate limit for docId=${docId}, waiting ${waitMs / 1000}s`);
        await delay(waitMs);
        await this.refreshSession();
        return this.fetchDocument(docId, docType, attempt + 1);
      }
      // Check if error response contains anti-bot indicators
      if (error?.response?.data && isAntiBotResponse(error.response.data) && attempt < 2) {
        const cooldown = attempt === 0 ? ANTI_BOT_COOLDOWN : ANTI_BOT_COOLDOWN * 2;
        console.warn(
          `[taobao] docId=${docId} 错误响应中检测到反爬，冷却 ${cooldown / 60000} 分钟...`,
        );
        await delay(cooldown);
        await this.refreshSession();
        return this.fetchDocument(docId, docType, attempt + 1);
      }
      throw error;
    }
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    await this.initSession();

    console.log('[taobao] 获取 API 目录树...');
    const categories = await this.fetchCatalogTree();

    const entries: DocEntry[] = [];
    for (const category of categories) {
      const categoryName = category.name;
      if (!category.catelogList) continue;

      for (const item of category.catelogList) {
        entries.push({
          path: `${categoryName}/${item.name}`,
          title: `${item.name}（${item.subName}）`,
          apiPath: item.name,
          docType: 'api_reference',
          sourceUrl: `${BASE_URL}/api.htm?docId=${item.docId}&docType=${item.docType}`,
          platformId: String(item.docId),
          lastUpdated: undefined,
        });
      }
    }

    console.log(
      `[taobao] 目录加载完成: ${categories.length} 个分类, ${entries.length} 个 API`,
    );
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const docId = Number(entry.platformId);
    if (!docId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    await this.throttle();

    const doc = await this.fetchDocument(docId, 2);
    const markdown = docToMarkdown(doc);

    const errorCodes = doc.errorCodes?.map((ec) => ({
      code: ec.errorCode,
      message: ec.errorMsg,
      description: ec.solution,
    }));

    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {};
    if (doc.gmtModified) {
      const date = new Date(doc.gmtModified);
      if (!isNaN(date.getTime())) {
        metadata.lastUpdated = date.toISOString().split('T')[0];
      }
    }
    if (doc.labels && doc.labels.length > 0) {
      metadata.labels = doc.labels.map((l) => (typeof l === 'string' ? l : l.displayName)).filter(Boolean);
    }
    metadata.tokenizedTitle = tokenizedTitle;
    metadata.tokenizedContent = tokenizedContent;

    return {
      markdown,
      apiPath: doc.name,
      errorCodes: errorCodes && errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
