import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';
import { createEgoPage, type EgoPage, type EgoResponse } from '../utils/ego-page.js';

/** 浏览器页面 / 响应类型 — 由 ego lite 提供 */
type Page = EgoPage;
type Response = EgoResponse;

// ── 常量 ──────────────────────────────────────────────────────────────────────

const XHS_BASE = 'https://open.xiaohongshu.com';
const DOC_BASE = `${XHS_BASE}/document/api`;


/** 页面导航完成后的额外缓冲（ms），给次要响应收尾 */
const SETTLE_DELAY = 1200;

/** 页面加载超时（ms） */
const PAGE_TIMEOUT = 30_000;

/** 必须等到的响应超时（ms） */
const RESP_TIMEOUT = 15_000;

/** 默认网关（电商开放平台） */
const DEFAULT_GATEWAY_ID = '103';
const DEFAULT_GATEWAY_VERSION = '1661';

/** 拉一级菜单时用的种子文档页（任一可访问的 API 详情页即可） */
const SEED_DOC_URL =
  `${DOC_BASE}?apiNavigationId=35&id=1&gatewayId=${DEFAULT_GATEWAY_ID}&gatewayVersionId=${DEFAULT_GATEWAY_VERSION}&apiId=5747&apiParentNavigationId=14`;

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface Level1Node {
  id: number;
  navigationName: string;
  seq?: number;
}

interface ApiLeaf {
  apiId: number;
  apiNavigationId: number;
  gatewayId: number;
  gatewayVersionId: number;
  id: number;
  method: string;
  navigationDetailDesc?: string;
  navigationDetailName?: string;
  path: string;
  seq?: number;
}

interface ApiInfo {
  data: {
    id: number;
    path: string;
    method: string;
    summary?: string;
    specJson: OpenAPIOperation;
  };
}

interface OpenAPIOperation {
  summary?: string;
  description?: string;
  requestBody?: { content?: Record<string, { schema?: JSONSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JSONSchema }> }>;
}

interface JSONSchema {
  type?: string;
  description?: string;
  example?: unknown;
  required?: string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  enum?: unknown[];
}

interface XhsErrorCode {
  apiNavigationDetailId: number;
  errorCode: number;
  errorDesc?: string;
}

interface ParamRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example?: string;
}

// ── 工具 ──────────────────────────────────────────────────────────────────────


/**
 * 解析小红书目录类接口：外层 `{ data: "<字符串化 JSON>", error_code, success }`，
 * data 是再次字符串化的 JSON，需 parse 两次；error_code 非 0 表示签名/权限失败。
 * （响应有时带 0&& XSSI 前缀，先剥掉。）
 */
function unwrapListBody<T>(text: string): T {
  const s = text.startsWith('0&&') ? text.slice(3) : text;
  const outer = JSON.parse(s);
  if (outer && typeof outer === 'object' && outer.error_code !== 0 && outer.error_code != null) {
    throw new Error(`[xiaohongshu] 接口返回 error_code=${outer.error_code}（签名/权限失败）`);
  }
  const data = outer?.data;
  if (typeof data === 'string') return JSON.parse(data) as T;
  return data as T;
}

/** 解析 OpenAPI 形态接口（infoNew / paramNew）：`{ code, success, data: {...} }` */
function unwrapApiBody<T>(text: string): T {
  const s = text.startsWith('0&&') ? text.slice(3) : text;
  return JSON.parse(s) as T;
}

// ── OpenAPI Schema → 参数表 ──────────────────────────────────────────────────

/** 把嵌套 schema 展平为参数表行（点号路径，数组用 `[]` 标记） */
function schemaToRows(schema: JSONSchema | undefined, prefix = ''): ParamRow[] {
  if (!schema || typeof schema !== 'object') return [];
  const rows: ParamRow[] = [];

  if (schema.type === 'object' && schema.properties) {
    const req = schema.required || [];
    for (const [name, prop] of Object.entries(schema.properties)) {
      const fullName = prefix ? `${prefix}.${name}` : name;
      const required = req.includes(name);
      rows.push({
        name: fullName,
        type: describeType(prop),
        required,
        description: prop.description || '',
        example: formatExample(prop.example),
      });
      if (prop.type === 'object' && prop.properties) {
        rows.push(...schemaToRows(prop, fullName));
      } else if (prop.type === 'array' && prop.items && prop.items.type === 'object') {
        rows.push(...schemaToRows(prop.items, `${fullName}[]`));
      }
    }
  } else if (schema.type === 'array' && schema.items?.type === 'object') {
    rows.push(...schemaToRows(schema.items, prefix ? `${prefix}[]` : '[]'));
  }
  return rows;
}

function describeType(s: JSONSchema): string {
  if (!s.type) return s.properties ? 'object' : '';
  if (s.type === 'array') {
    const inner = s.items ? describeType(s.items) : '';
    return inner ? `array<${inner}>` : 'array';
  }
  return s.type;
}

function formatExample(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function renderTable(rows: ParamRow[], withRequired = true): string {
  if (rows.length === 0) return '';
  const cols = withRequired
    ? ['名称', '类型', '必填', '描述', '示例']
    : ['名称', '类型', '描述', '示例'];
  let md = `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`;
  for (const r of rows) {
    const cells = withRequired
      ? [r.name, r.type, r.required ? '是' : '否', escapeCell(r.description), escapeCell(r.example || '')]
      : [r.name, r.type, escapeCell(r.description), escapeCell(r.example || '')];
    md += `| ${cells.join(' | ')} |\n`;
  }
  return md + '\n';
}

/** 用 schema.example 填充示例对象（缺失时按类型给占位） */
function buildExampleObject(schema: JSONSchema | undefined): unknown {
  if (!schema) return undefined;
  if (schema.example != null) return schema.example;
  if (schema.type === 'object' && schema.properties) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      obj[k] = buildExampleObject(v);
    }
    return obj;
  }
  if (schema.type === 'array') {
    return schema.items ? [buildExampleObject(schema.items)] : [];
  }
  switch (schema.type) {
    case 'string':
      return '';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

// ── Markdown 组装 ────────────────────────────────────────────────────────────

function buildMarkdown(
  entry: DocEntry,
  info: ApiInfo | null,
  commonParams: ApiInfo | null,
  errorCodes: XhsErrorCode[],
): string {
  const spec = info?.data?.specJson || {};
  const apiPath = info?.data?.path || '';
  const method = (info?.data?.method || '').toUpperCase();
  const summary = spec.summary || entry.title.replace(/^[\w.]+\s*/, '');

  const parts: string[] = [];
  parts.push(`# ${entry.title}`);
  if (method && apiPath) parts.push(`**${method}** \`${apiPath}\``);
  if (summary && summary !== entry.title) parts.push(summary);
  if (spec.description) parts.push(spec.description);

  // 公共请求参数
  const commonReq = commonParams?.data?.specJson?.requestBody?.content?.['application/json']?.schema;
  if (commonReq) {
    const rows = schemaToRows(commonReq);
    if (rows.length > 0) {
      parts.push('## 公共请求参数', renderTable(rows));
    }
  }

  // 请求参数
  const reqSchema = spec.requestBody?.content?.['application/json']?.schema;
  if (reqSchema) {
    const rows = schemaToRows(reqSchema);
    parts.push('## 请求参数', rows.length > 0 ? renderTable(rows) : '_无_\n');
    const example = buildExampleObject(reqSchema);
    if (example !== undefined && example !== null) {
      parts.push('## 请求示例', '```json\n' + JSON.stringify(example, null, 2) + '\n```');
    }
  }

  // 响应参数
  const respSchema = spec.responses?.['200']?.content?.['application/json']?.schema;
  if (respSchema) {
    const rows = schemaToRows(respSchema);
    if (rows.length > 0) parts.push('## 响应参数', renderTable(rows, false));
    const example = buildExampleObject(respSchema);
    if (example !== undefined && example !== null) {
      parts.push('## 响应示例', '```json\n' + JSON.stringify(example, null, 2) + '\n```');
    }
  }

  // 错误码
  if (errorCodes.length > 0) {
    let tbl = '| 错误码 | 描述 |\n|---|---|\n';
    for (const ec of errorCodes) {
      tbl += `| ${ec.errorCode} | ${escapeCell(ec.errorDesc || '')} |\n`;
    }
    parts.push('## 错误码', tbl);
  }

  return parts.join('\n\n').trim();
}

// ── XiaohongshuSource ────────────────────────────────────────────────────────

/**
 * 小红书电商开放平台文档源适配器
 *
 * 实现：所有 /api/doc/* 接口都需要动态 `x-s` 签名（无法直接 axios 拉），故让 Playwright
 * 自然加载页面、监听 response 捕获 JSON 数据，再把 OpenAPI specJson 拼成 Markdown。
 *
 * 接口拓扑：
 *   /api/doc/listNew                              一级菜单（11 个分类）
 *   /api/doc/second/listNew?apiNavigationId=N     某一级下全部 API
 *   /api/doc/infoNew?gatewayId&gatewayVersionId&apiId   单 API OpenAPI 描述（请求/响应 schema）
 *   /api/doc/common/paramNew?gatewayId&gatewayVersionId 网关级公共参数（缓存复用）
 *   /api/doc/errorcodeNew?apiNavigationDetailId=N 单 API 错误码列表
 */
export class XiaohongshuSource implements DocSource {
  id = 'xiaohongshu';
  name = '小红书';

  private page: Page | null = null;
  /** 按 `${gatewayId}-${gatewayVersionId}` 缓存公共参数响应 */
  private commonParamsByGateway = new Map<string, ApiInfo>();

  private async ensureBrowser(): Promise<Page> {
    if (!this.page) {
      this.page = await createEgoPage();
      // 桥接侧只缓存 XHR/Fetch 响应；这里不限定 URL 片段，
      // 具体筛选交给 loadAndCapture 里的 match 函数
      await this.page.setCapturePatterns([]);
    }
    return this.page;
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
  }

  /**
   * 加载 URL 并捕获若干 API 响应。
   * - waitFor 数组中的所有 key 都必须在 RESP_TIMEOUT 内捕获到（否则抛错）
   * - alsoCapture 是可选捕获（仅作机会收集）
   * 返回 key → 响应体文本。
   */
  private async loadAndCapture(
    url: string,
    waitFor: Array<{ key: string; match: (u: string) => boolean }>,
    alsoCapture: Array<{ key: string; match: (u: string) => boolean }> = [],
  ): Promise<Record<string, string>> {
    const page = await this.ensureBrowser();
    const captures: Record<string, string> = {};
    const matchers = [...waitFor, ...alsoCapture];

    const onResp = async (r: Response) => {
      const u = r.url();
      for (const m of matchers) {
        if (captures[m.key]) continue;
        if (m.match(u)) {
          try {
            captures[m.key] = await r.text();
          } catch {
            /* 某些响应可能 navigate away，忽略 */
          }
          break;
        }
      }
    };
    page.on('response', onResp);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      const start = Date.now();
      while (Date.now() - start < RESP_TIMEOUT) {
        if (waitFor.every((m) => m.key in captures)) break;
        await delay(200);
      }
      // 收尾期：给可选响应（errorcode 可能滞后）一点机会
      await delay(SETTLE_DELAY);
    } finally {
      page.off('response', onResp);
    }

    const missing = waitFor.filter((m) => !(m.key in captures)).map((m) => m.key);
    if (missing.length > 0) {
      throw new Error(`[xiaohongshu] 必须的响应未捕获: ${missing.join(', ')} (url=${url})`);
    }
    return captures;
  }

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[xiaohongshu] 加载种子页，捕获一级菜单 + 公共参数...');
    const seedCaptures = await this.loadAndCapture(
      SEED_DOC_URL,
      [{ key: 'list', match: (u) => u.includes('/api/doc/listNew') }],
      [{ key: 'param', match: (u) => u.includes('/api/doc/common/paramNew') }],
    );

    const level1List = unwrapListBody<Level1Node[]>(seedCaptures.list);
    console.log(
      `[xiaohongshu] 一级分类 ${level1List.length} 个: ${level1List.map((l) => l.navigationName).join(', ')}`,
    );

    if (seedCaptures.param) {
      this.commonParamsByGateway.set(
        `${DEFAULT_GATEWAY_ID}-${DEFAULT_GATEWAY_VERSION}`,
        unwrapApiBody<ApiInfo>(seedCaptures.param),
      );
    }

    const entries: DocEntry[] = [];
    for (const l1 of level1List) {
      if (!l1.id || !l1.navigationName) continue;
      // 该分类下任意一个占位 URL，只要 apiNavigationId 在 URL 上，页面就会请求 second/listNew
      const catUrl = `${DOC_BASE}?apiNavigationId=${l1.id}&apiParentNavigationId=${l1.id}&id=0&gatewayId=${DEFAULT_GATEWAY_ID}&gatewayVersionId=${DEFAULT_GATEWAY_VERSION}&apiId=0`;
      try {
        const captures = await this.loadAndCapture(catUrl, [
          {
            key: 'second',
            match: (u) =>
              u.includes('/api/doc/second/listNew') && u.includes(`apiNavigationId=${l1.id}`),
          },
        ]);
        const apis = unwrapListBody<ApiLeaf[]>(captures.second);
        console.log(`[xiaohongshu]   ${l1.navigationName}: ${apis.length} 个 API`);
        for (const api of apis) {
          if (!api.path || api.apiId == null || api.id == null) continue;
          entries.push({
            path: `${l1.navigationName}/${api.path}`,
            title: api.navigationDetailDesc
              ? `${api.path} ${api.navigationDetailDesc}`
              : api.path,
            sourceUrl:
              `${DOC_BASE}?apiNavigationId=${api.apiNavigationId}&id=${api.id}` +
              `&gatewayId=${api.gatewayId}&gatewayVersionId=${api.gatewayVersionId}` +
              `&apiId=${api.apiId}&apiParentNavigationId=${l1.id}`,
            docType: 'api_reference',
            platformId: api.path,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[xiaohongshu]   ${l1.navigationName} 抓取失败，跳过: ${msg}`);
      }
    }

    console.log(`[xiaohongshu] 目录提取完成，共 ${entries.length} 篇`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const url = entry.sourceUrl;
    if (!url) throw new Error(`[xiaohongshu] 文档缺少 sourceUrl: ${entry.title}`);

    const params = new URL(url).searchParams;
    const apiId = params.get('apiId');
    const apiNavigationId = params.get('apiNavigationId');
    const gatewayId = params.get('gatewayId') || DEFAULT_GATEWAY_ID;
    const gatewayVersionId = params.get('gatewayVersionId') || DEFAULT_GATEWAY_VERSION;
    const gwKey = `${gatewayId}-${gatewayVersionId}`;

    if (!apiId || !apiNavigationId) {
      throw new Error(`[xiaohongshu] sourceUrl 缺少 apiId/apiNavigationId: ${url}`);
    }

    const waitFor: Array<{ key: string; match: (u: string) => boolean }> = [
      {
        key: 'info',
        match: (u) => u.includes('/api/doc/infoNew') && u.includes(`apiId=${apiId}`),
      },
    ];
    const alsoCapture: Array<{ key: string; match: (u: string) => boolean }> = [
      {
        key: 'error',
        match: (u) =>
          u.includes('/api/doc/errorcodeNew') &&
          u.includes(`apiNavigationDetailId=${apiNavigationId}`),
      },
    ];
    if (!this.commonParamsByGateway.has(gwKey)) {
      alsoCapture.push({
        key: 'param',
        match: (u) =>
          u.includes('/api/doc/common/paramNew') &&
          u.includes(`gatewayId=${gatewayId}`) &&
          u.includes(`gatewayVersionId=${gatewayVersionId}`),
      });
    }

    const captures = await this.loadAndCapture(url, waitFor, alsoCapture);

    const info = unwrapApiBody<ApiInfo>(captures.info);
    if (captures.param) {
      this.commonParamsByGateway.set(gwKey, unwrapApiBody<ApiInfo>(captures.param));
    }
    const commonParams = this.commonParamsByGateway.get(gwKey) || null;

    let errorCodes: XhsErrorCode[] = [];
    if (captures.error) {
      try {
        errorCodes = unwrapListBody<XhsErrorCode[]>(captures.error) || [];
      } catch {
        errorCodes = [];
      }
    }

    const markdown = buildMarkdown(entry, info, commonParams, errorCodes);
    const apiPath = info?.data?.path || entry.platformId;

    return {
      markdown,
      apiPath,
      errorCodes:
        errorCodes.length > 0
          ? errorCodes.map((c) => ({
              code: String(c.errorCode),
              description: c.errorDesc,
            }))
          : undefined,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
