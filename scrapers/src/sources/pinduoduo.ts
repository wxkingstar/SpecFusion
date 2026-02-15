import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import axios, { type AxiosInstance } from 'axios';
import { tokenize } from '../utils/tokenizer.js';
import { parseCookieString, toCookieHeader, type CookieEntry } from '../utils/cookies.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const API_BASE = 'https://open-api.pinduoduo.com';
const SITE_BASE = 'https://open.pinduoduo.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms） */
const REQUEST_DELAY = 300;

/**
 * JSON 数据文件路径。
 * 由于拼多多 info/get 端点需要浏览器 httpOnly cookie，
 * 无法通过 curl/axios 直接调用。因此采用 "浏览器提取 → JSON 导入" 模式：
 * 1. 在已登录的浏览器中运行 JS 批量获取所有 API 详情
 * 2. 导出为 pdd_api_docs.json（浏览器自动下载）
 * 3. 将文件放到 scrapers/data/ 目录
 * 4. 运行 `npm run sync -- --source pinduoduo` 导入
 *
 * 支持环境变量 PDD_JSON_PATH 指定自定义路径。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JSON_PATH = resolve(__dirname, '../../data/pdd_api_docs.json');

// ─── API response interfaces ────────────────────────────────────────────────

interface PddResponse<T> {
  success: boolean;
  errorCode: number;
  errorMsg: string | null;
  result: T;
}

interface PddCategory {
  id: number;
  name: string;
}

interface PddDocListResult {
  docList: PddDocListItem[];
}

interface PddDocListItem {
  id: string; // e.g. "pdd.erp.order.sync"
  scopeName: string;
  scopeNameId: number;
  apiName: string;
  usageScenarios: string;
  createdAt: number;
  updatedAt: number;
  scopeTips: string;
}

interface PddDocDetail {
  id: number;
  catId: number;
  apiName: string;
  scopeName: string;
  usageScenarios: string;
  needOauth: number;
  chargeType: number;
  platform: number;
  scenesName: string | null;
  updatedAt: number;
  requestCodeExample: string | null;
  responseCodeExample: string | null;
  requestParamList: PddParam[];
  responseParamList: PddParam[];
  errorParamList: PddErrorCode[];
  showErrorParamList: PddShowError[];
  limiters: PddLimiter[];
  permissionsPkgs: PddPermissionPkg[];
  sdkDemos: Record<string, string> | null;
}

interface PddParam {
  id: number;
  parentId: number;
  childrenNum: number;
  paramName: string;
  paramType: string;
  isMust?: number;
  defaultValue?: string;
  example?: string;
  paramDesc: string;
  sourcePath?: string | null;
  isEncrypted?: boolean | null;
}

interface PddErrorCode {
  errorCode: string;
  errorMsg: string;
  solution: string;
  outerErrorCode: string;
}

interface PddShowError {
  mainErrorCode: string;
  mainErrorMsg: string;
  subErrorList: PddErrorCode[];
}

interface PddLimiter {
  limiterLevel: number;
  timeRange: number;
  times: number;
  callSourceType: number;
}

interface PddPermissionPkg {
  id: number;
  name: string;
  description: string;
  appTypeList: Array<{ id: number; name: string; status: number }>;
}

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── JSON → Markdown conversion ─────────────────────────────────────────────

type ParamNode = PddParam & { children: ParamNode[] };

function buildParamTree(params: PddParam[]): ParamNode[] {
  const map = new Map<number, ParamNode>();
  const roots: ParamNode[] = [];

  for (const p of params) {
    map.set(p.id, { ...p, children: [] });
  }

  for (const p of params) {
    const node = map.get(p.id)!;
    if (p.parentId === 0) {
      roots.push(node);
    } else {
      const parent = map.get(p.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}

function renderParamTable(params: PddParam[], title: string, isResponse = false): string {
  if (!params || params.length === 0) return '';

  const tree = buildParamTree(params);
  const lines: string[] = [];
  lines.push(`## ${title}\n`);

  if (isResponse) {
    lines.push('| 名称 | 类型 | 描述 |');
    lines.push('|------|------|------|');
  } else {
    lines.push('| 名称 | 类型 | 必填 | 描述 |');
    lines.push('|------|------|------|------|');
  }

  function renderRow(node: ParamNode, indent: number): void {
    const prefix = indent > 0 ? '&nbsp;'.repeat(indent * 2) + '└ ' : '';
    const name = `${prefix}${node.paramName}`;
    const type = node.paramType || '';
    const desc = escapeCell(node.paramDesc || '');

    if (isResponse) {
      lines.push(`| ${escapeCell(name)} | ${type} | ${desc} |`);
    } else {
      const required = node.isMust === 1 ? '必填' : '非必填';
      lines.push(`| ${escapeCell(name)} | ${type} | ${required} | ${desc} |`);
    }

    for (const child of node.children) {
      renderRow(child, indent + 1);
    }
  }

  for (const root of tree) {
    renderRow(root, 0);
  }

  lines.push('');
  return lines.join('\n');
}

function renderErrorCodesTable(errors: PddShowError[]): string {
  if (!errors || errors.length === 0) return '';

  const lines: string[] = [];
  lines.push('## 错误码\n');
  lines.push('| 主错误码 | 主错误描述 | 子错误码 | 子错误描述 | 解决办法 |');
  lines.push('|----------|----------|----------|----------|----------|');

  for (const err of errors) {
    if (err.subErrorList && err.subErrorList.length > 0) {
      for (const sub of err.subErrorList) {
        lines.push(
          `| ${escapeCell(err.mainErrorCode)} | ${escapeCell(err.mainErrorMsg)} | ${escapeCell(sub.errorCode)} | ${escapeCell(sub.errorMsg)} | ${escapeCell(sub.solution || '')} |`,
        );
      }
    } else {
      lines.push(
        `| ${escapeCell(err.mainErrorCode)} | ${escapeCell(err.mainErrorMsg)} | | | |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function docToMarkdown(doc: PddDocDetail, categoryName: string): string {
  const sections: string[] = [];

  // Title
  sections.push(`# ${doc.scopeName}\n`);

  // Description
  if (doc.apiName) {
    sections.push(`**${doc.apiName}**\n`);
  }
  if (doc.usageScenarios) {
    sections.push(`${doc.usageScenarios}\n`);
  }

  // Tags
  const tags: string[] = [];
  if (doc.chargeType === 0) tags.push('免费API');
  if (doc.needOauth === 1) tags.push('必须用户授权');
  if (tags.length > 0) {
    sections.push(`标签：${tags.join('、')}\n`);
  }

  // Category
  sections.push(`分类：${categoryName}\n`);

  // Request URL (fixed for PDD)
  sections.push('## 请求地址\n');
  sections.push('| 环境 | HTTP地址 | HTTPS地址 |');
  sections.push('|------|----------|-----------|');
  sections.push('| 正式环境 | http://gw-api.pinduoduo.com/api/router | https://gw-api.pinduoduo.com/api/router |');
  sections.push('');

  // Request params
  if (doc.requestParamList && doc.requestParamList.length > 0) {
    sections.push(renderParamTable(doc.requestParamList, '请求参数'));
  }

  // Response params
  if (doc.responseParamList && doc.responseParamList.length > 0) {
    sections.push(renderParamTable(doc.responseParamList, '响应参数', true));
  }

  // Response example
  if (doc.responseCodeExample) {
    sections.push('## 响应示例\n');
    try {
      const formatted = JSON.stringify(JSON.parse(doc.responseCodeExample), null, 2);
      sections.push('```json\n' + formatted + '\n```\n');
    } catch {
      sections.push('```json\n' + doc.responseCodeExample + '\n```\n');
    }
  }

  // SDK demos
  if (doc.sdkDemos) {
    for (const [lang, code] of Object.entries(doc.sdkDemos)) {
      if (code && typeof code === 'string') {
        const langLower = lang.toLowerCase();
        const langTag = langLower === 'curl' ? 'bash' : langLower;
        sections.push(`## ${lang} 示例\n`);
        sections.push(`\`\`\`${langTag}\n${code}\n\`\`\`\n`);
      }
    }
  }

  // Error codes
  if (doc.showErrorParamList && doc.showErrorParamList.length > 0) {
    sections.push(renderErrorCodesTable(doc.showErrorParamList));
  }

  // Permission packages
  if (doc.permissionsPkgs && doc.permissionsPkgs.length > 0) {
    sections.push('## 权限要求\n');
    for (const pkg of doc.permissionsPkgs) {
      const appTypes = pkg.appTypeList?.map((a) => a.name).join('、') || '';
      sections.push(`- **${pkg.name}**：${appTypes}`);
    }
    sections.push('');
  }

  // Rate limit
  if (doc.limiters && doc.limiters.length > 0) {
    sections.push('## 限流规则\n');
    for (const limiter of doc.limiters) {
      sections.push(`接口总限流频次：${limiter.times}次/${limiter.timeRange}秒\n`);
    }
  }

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── JSON dump file interfaces ──────────────────────────────────────────────

interface PddJsonDump {
  categories: PddCategory[];
  catMap: Record<string, string>;
  apiList: Array<PddDocListItem & { _catId: number; _catName: string }>;
  details: Array<PddDocDetail & { _catId: number; _catName: string }>;
  exportedAt: string;
}

// ─── PinduoduoSource class ──────────────────────────────────────────────────

export class PinduoduoSource implements DocSource {
  id = 'pinduoduo';
  name = '拼多多开放平台';

  private client!: AxiosInstance;
  private cookies: CookieEntry[];
  private requestCount = 0;
  /** category id → name */
  private categoryMap = new Map<number, string>();
  /** JSON dump data (loaded lazily) */
  private jsonData: PddJsonDump | null = null;
  /** detail lookup map: apiId (scopeName) → detail */
  private detailMap = new Map<string, PddDocDetail & { _catName: string }>();

  constructor() {
    this.cookies = parseCookieString(process.env.PDD_COOKIE || '');

    // 仅在非 JSON 模式下初始化 HTTP client
    if (!this.getJsonPath()) {
      this.initClient();
    }
  }

  private getJsonPath(): string | null {
    const envPath = process.env.PDD_JSON_PATH;
    if (envPath && existsSync(envPath)) return envPath;
    if (existsSync(DEFAULT_JSON_PATH)) return DEFAULT_JSON_PATH;
    return null;
  }

  private initClient(): void {
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${SITE_BASE}/application/document/api`,
      },
      timeout: 30_000,
    });

    if (this.cookies.length > 0) {
      this.client.defaults.headers.common['Cookie'] = toCookieHeader(this.cookies);
    }
  }

  private loadJsonData(): PddJsonDump {
    if (this.jsonData) return this.jsonData;

    const jsonPath = this.getJsonPath();
    if (!jsonPath) {
      throw new Error(
        '找不到 pdd_api_docs.json。\n' +
          '拼多多 API 详情需要浏览器 httpOnly cookie，无法通过 curl/axios 直接获取。\n' +
          '请在已登录的浏览器控制台中运行导出脚本，将 JSON 放到 scrapers/data/pdd_api_docs.json\n' +
          '或设置 PDD_JSON_PATH 环境变量指定文件路径。',
      );
    }

    console.log(`[pinduoduo] 从 JSON 文件加载数据: ${jsonPath}`);
    const raw = readFileSync(jsonPath, 'utf-8');
    this.jsonData = JSON.parse(raw) as PddJsonDump;

    // Build detail lookup map
    for (const detail of this.jsonData.details) {
      // scopeName is the API ID like "pdd.erp.order.sync"
      this.detailMap.set(detail.scopeName, detail);
    }

    console.log(
      `[pinduoduo] JSON 数据加载完成: ${this.jsonData.categories.length} 个分类, ` +
        `${this.jsonData.details.length} 个 API 详情 (导出时间: ${this.jsonData.exportedAt})`,
    );
    return this.jsonData;
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 100 === 0) {
      console.log(`[pinduoduo] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── Online API calls (fallback) ──────────────────────────────────────

  /** 获取所有 API 分类 */
  private async fetchCategories(): Promise<PddCategory[]> {
    const resp = await this.client.get<PddResponse<PddCategory[]>>(
      '/pop/doc/category/list',
    );
    if (!resp.data.success) {
      throw new Error(`获取分类列表失败: ${resp.data.errorMsg || resp.data.errorCode}`);
    }
    return resp.data.result;
  }

  /** 获取某分类下的所有 API 列表 */
  private async fetchDocList(catId: number): Promise<PddDocListItem[]> {
    const resp = await this.client.post<PddResponse<PddDocListResult>>(
      '/pop/doc/info/list/byCat',
      { id: catId },
    );
    if (!resp.data.success) {
      throw new Error(`获取分类 ${catId} 文档列表失败: ${resp.data.errorMsg || resp.data.errorCode}`);
    }
    return resp.data.result?.docList || [];
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    const jsonPath = this.getJsonPath();

    // ── JSON 文件模式 ──
    if (jsonPath) {
      const data = this.loadJsonData();

      // Build category map
      for (const cat of data.categories) {
        this.categoryMap.set(cat.id, cat.name);
      }

      const entries: DocEntry[] = data.apiList.map((api) => ({
        path: `${api._catName}/${api.id}`,
        title: `${api.id}（${api.apiName}）`,
        apiPath: api.id,
        docType: 'api_reference',
        sourceUrl: `${SITE_BASE}/application/document/api?id=${api.id}`,
        platformId: api.id,
        lastUpdated: api.updatedAt
          ? new Date(api.updatedAt).toISOString().split('T')[0]
          : undefined,
      }));

      console.log(`[pinduoduo] 从 JSON 加载目录: ${entries.length} 个 API`);
      return entries;
    }

    // ── 在线 API 模式（仅 catalog，不需要 cookie） ──
    if (!this.client) this.initClient();

    console.log('[pinduoduo] 获取 API 分类列表...');
    const categories = await this.fetchCategories();
    console.log(`[pinduoduo] 发现 ${categories.length} 个 API 分类`);

    for (const cat of categories) {
      this.categoryMap.set(cat.id, cat.name);
    }

    const entries: DocEntry[] = [];

    for (const category of categories) {
      await this.throttle();
      try {
        const docList = await this.fetchDocList(category.id);
        console.log(`[pinduoduo] ${category.name} (catId=${category.id}): ${docList.length} 个 API`);
        for (const doc of docList) {
          entries.push({
            path: `${category.name}/${doc.id}`,
            title: `${doc.id}（${doc.apiName}）`,
            apiPath: doc.id,
            docType: 'api_reference',
            sourceUrl: `${SITE_BASE}/application/document/api?id=${doc.id}`,
            platformId: doc.id,
            lastUpdated: doc.updatedAt
              ? new Date(doc.updatedAt).toISOString().split('T')[0]
              : undefined,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[pinduoduo] 获取分类 ${category.name} 失败: ${msg}`);
      }
    }

    console.log(`[pinduoduo] 目录加载完成: ${categories.length} 个分类, ${entries.length} 个 API`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const apiId = entry.platformId;
    if (!apiId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    // 优先从 JSON 数据获取详情
    if (this.getJsonPath()) {
      this.loadJsonData();
    }

    const cached = this.detailMap.get(apiId);
    if (!cached) {
      throw new Error(
        `API ${apiId} 在 JSON 数据中未找到。请重新从浏览器导出数据。`,
      );
    }

    const categoryName = cached._catName || this.categoryMap.get(cached.catId) || `分类${cached.catId}`;
    const markdown = docToMarkdown(cached, categoryName);

    // Extract error codes
    const errorCodes = cached.errorParamList
      ?.filter((ec) => ec.errorCode)
      .map((ec) => ({
        code: ec.errorCode,
        message: ec.errorMsg,
        description: ec.solution,
      }));

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (cached.updatedAt) {
      const date = new Date(cached.updatedAt);
      if (!isNaN(date.getTime())) {
        metadata.lastUpdated = date.toISOString().split('T')[0];
      }
    }

    return {
      markdown,
      apiPath: cached.scopeName,
      errorCodes: errorCodes && errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
