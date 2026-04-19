import axios, { type AxiosInstance } from 'axios';
import { load, type CheerioAPI } from 'cheerio';
import { decode } from 'html-entities';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://open.italent.cn';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms） */
const REQUEST_DELAY = 200;

/** Schema 渲染最大递归深度，避免循环引用 */
const MAX_SCHEMA_DEPTH = 6;

// ─── API response interfaces ────────────────────────────────────────────────

interface BeisenResponse<T> {
  data: T;
  errmsg: string;
  errcode: number;
}

interface BeisenLevel1Menu {
  name: string;
  app_id: string;
  open_app_id: string;
  app_type: number;
  sort_code: string;
}

interface BeisenMenuNode {
  key: string;
  name: string;
  /** 1=folder, 2=external link, 3=API interface */
  type: number;
  httpMethod: number;
  open_app_id: string;
  visible: boolean;
  url: string;
  pid: string;
  Sort: number;
  directoryType: number;
  openInterfaceId: string | null;
  children: BeisenMenuNode[];
  hasChildren: boolean;
  level: number;
  isDelete: boolean;
}

interface BeisenDocDetail {
  interface_id: string;
  micro_service_id: string;
  open_app_id: string;
  interface_name: string;
  http_method: string; // "GET" / "POST"
  interface_url: string;
  limit_desc: string;
  permission_desc: string | null;
  disable: boolean;
  resouce_title: string;
  resouce_code: string;
  scene: string;
  warning: string;
  tips: string; // HTML
  parameter: string; // JSON string (OpenAPI-like Schema)
  response: string; // JSON string
  parameter_example: string;
  response_example: string;
  exception_example: string;
  error_code: string;
  publish_status: number;
  open_range: number;
  open_tenant_ids: unknown;
  modified_time: string; // "2025/11/15 22:10:09"
}

interface OpenApiSchema {
  $ref?: string;
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  enum?: unknown[];
  'x-generic'?: string;
}

interface OpenApiSpec {
  parameter?: Array<{ name: string; in: string; description?: string; schema?: OpenApiSchema }>;
  response?: Record<string, { description?: string; schema?: OpenApiSchema }>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

// ─── Utility helpers ────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

/** 字段可能含 HTML 或纯文本，统一转成 Markdown 文本 */
function normalizeRichText(s: string | undefined | null): string {
  if (!s) return '';
  const str = s.replace(/\r\n/g, '\n');
  // 含 HTML 标签时走 htmlToMarkdown，否则保持原文
  if (/<[a-zA-Z][^>]*>/.test(str)) return htmlToMarkdown(str);
  return str.trim();
}

/** 表格单元格里可能含 HTML（如 description），先去 HTML 再转义 */
function cleanCell(text: string | undefined | null): string {
  if (!text) return '';
  let s = text.replace(/\r\n/g, ' ');
  if (/<[a-zA-Z][^>]*>/.test(s)) {
    s = htmlToMarkdown(s);
  }
  return escapeCell(decode(s));
}

/** 解析形如 "2025/11/15 22:10:09" 的时间字符串为 ISO yyyy-mm-dd */
function parseBeisenTime(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ─── HTML → Markdown conversion ─────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';

  const $: CheerioAPI = load(html);

  $('pre').each((_, el) => {
    const $el = $(el);
    const code = $el.find('code');
    const lang = code.attr('class')?.replace(/^language-/, '') || '';
    const text = decode(code.length ? code.text() : $el.text());
    $el.replaceWith(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`);
  });

  $('code').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`\`${text}\``);
  });

  for (let i = 1; i <= 6; i++) {
    $(`h${i}`).each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      if (text) $el.replaceWith(`\n${'#'.repeat(i)} ${text}\n`);
    });
  }

  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const text = $el.text().trim();
    if (text && href && !href.startsWith('javascript:')) {
      $el.replaceWith(`[${text}](${href})`);
    } else if (text) {
      $el.replaceWith(text);
    }
  });

  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || '';
    const alt = $el.attr('alt') || '';
    if (src) $el.replaceWith(`![${alt}](${src})`);
  });

  $('table').each((_, table) => {
    const $table = $(table);
    const rows: string[][] = [];
    let maxCols = 0;
    $table.find('tr').each((_, tr) => {
      const cells: string[] = [];
      $(tr).find('th, td').each((_, cell) => {
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

  $('br').replaceWith('\n');

  $('p').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`\n${$el.html()}\n`);
  });

  $('strong, b').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`**${text}**`);
  });

  $('em, i').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`*${text}*`);
  });

  let md = decode($.root().text());
  md = stripHtmlComments(md);
  md = md.replace(/<[^>]+>/g, '');
  md = collapseBlankLines(md);
  return md.trim();
}

// ─── OpenAPI Schema → Markdown table ────────────────────────────────────────

/** 解析 $ref 引用到 schemas 对应节点 */
function resolveRef(ref: string, schemas: Record<string, OpenApiSchema>): OpenApiSchema | null {
  // "#/components/schemas/xxx"
  const match = ref.match(/#\/components\/schemas\/(.+)$/);
  if (!match) return null;
  return schemas[match[1]] || null;
}

function getTypeString(schema: OpenApiSchema, schemas: Record<string, OpenApiSchema>): string {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, schemas);
    if (resolved) return getTypeString(resolved, schemas);
    return 'object';
  }
  if (schema.type === 'array' && schema.items) {
    return `array<${getTypeString(schema.items, schemas)}>`;
  }
  if (schema.type) {
    return schema.format ? `${schema.type}(${schema.format})` : schema.type;
  }
  if (schema.properties) return 'object';
  return '-';
}

/**
 * 把一个 schema (通常是 object 的 properties) 渲染成树状 Markdown 表格。
 * prefix 用于表示嵌套层级（如 "└─ "），depth 用于防止无限递归。
 */
function renderSchemaRows(
  schema: OpenApiSchema,
  schemas: Record<string, OpenApiSchema>,
  depth: number,
  visited: Set<string>,
  prefix: string,
): string[] {
  if (depth > MAX_SCHEMA_DEPTH) return [];

  // 解引用
  let current: OpenApiSchema | null = schema;
  if (current.$ref) {
    if (visited.has(current.$ref)) return [];
    const newVisited = new Set(visited);
    newVisited.add(current.$ref);
    const resolved = resolveRef(current.$ref, schemas);
    if (!resolved) return [];
    return renderSchemaRows(resolved, schemas, depth, newVisited, prefix);
  }

  const rows: string[] = [];

  // 数组: 展开 items
  if (current.type === 'array' && current.items) {
    const itemType = getTypeString(current.items, schemas);
    // 只在有 description 时追加一行说明数组元素
    if (current.description) {
      rows.push(`| ${prefix}(array) | ${itemType} | - | ${cleanCell(current.description)} |`);
    }
    // 展开 items 的 properties
    return rows.concat(renderSchemaRows(current.items, schemas, depth + 1, visited, prefix));
  }

  // object: 遍历 properties
  const requiredSet = new Set(current.required || []);
  const props = current.properties || {};

  for (const [name, propSchema] of Object.entries(props)) {
    let prop: OpenApiSchema = propSchema;
    let refChain = visited;

    // 解引用 (可能多层)
    while (prop.$ref) {
      if (refChain.has(prop.$ref)) break;
      const newVisited = new Set(refChain);
      newVisited.add(prop.$ref);
      refChain = newVisited;
      const resolved = resolveRef(prop.$ref, schemas);
      if (!resolved) break;
      prop = { ...resolved, description: prop.description || resolved.description };
    }

    const typeStr = getTypeString(prop, schemas);
    const required = requiredSet.has(name) ? '是' : '否';
    const desc = cleanCell(prop.description || '');

    rows.push(`| ${prefix}${name} | ${typeStr} | ${required} | ${desc} |`);

    // 递归展开 object / array
    if (depth < MAX_SCHEMA_DEPTH) {
      if (prop.type === 'object' && prop.properties && Object.keys(prop.properties).length > 0) {
        rows.push(
          ...renderSchemaRows(prop, schemas, depth + 1, refChain, prefix + '　├ '),
        );
      } else if (prop.type === 'array' && prop.items) {
        // items 若为 object 展开其 properties
        let items: OpenApiSchema = prop.items;
        if (items.$ref && !refChain.has(items.$ref)) {
          const newVisited = new Set(refChain);
          newVisited.add(items.$ref);
          const resolved = resolveRef(items.$ref, schemas);
          if (resolved) {
            items = resolved;
            refChain = newVisited;
          }
        }
        if (items.properties && Object.keys(items.properties).length > 0) {
          rows.push(
            ...renderSchemaRows(items, schemas, depth + 1, refChain, prefix + '　├ '),
          );
        }
      }
    }
  }

  return rows;
}

/** 把北森 parameter/response JSON 字符串渲染成 Markdown */
function renderOpenApiSchema(jsonStr: string, label: 'parameter' | 'response'): string {
  if (!jsonStr) return '';
  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(jsonStr);
  } catch {
    return '';
  }
  const schemas = spec.components?.schemas || {};

  if (label === 'parameter') {
    const params = spec.parameter || [];
    if (params.length === 0) return '';
    const lines: string[] = [];
    lines.push('| 参数 | 类型 | 必填 | 说明 |');
    lines.push('|------|------|------|------|');

    for (const p of params) {
      if (!p.schema) continue;
      // p.schema 通常是一个 $ref 指向 RequestBody_xxx
      let current: OpenApiSchema = p.schema;
      const visited = new Set<string>();
      while (current.$ref) {
        if (visited.has(current.$ref)) break;
        visited.add(current.$ref);
        const resolved = resolveRef(current.$ref, schemas);
        if (!resolved) break;
        current = resolved;
      }
      // 如果是 object 展开 properties；否则当单参数
      if (current.properties) {
        const rows = renderSchemaRows(current, schemas, 0, visited, '');
        lines.push(...rows);
      } else {
        const desc = cleanCell(p.description || current.description || '');
        const typeStr = getTypeString(current, schemas);
        lines.push(`| ${p.name} | ${typeStr} | - | ${desc} |`);
      }
    }
    return lines.length > 2 ? lines.join('\n') : '';
  }

  // response: spec.response 通常有多个状态码（"200" 等）
  const responses = spec.response || {};
  const sections: string[] = [];
  for (const [code, resp] of Object.entries(responses)) {
    if (!resp.schema) continue;
    const header: string[] = [];
    header.push(`**状态码 ${code}**${resp.description ? ` - ${resp.description}` : ''}`);
    header.push('');
    let current: OpenApiSchema = resp.schema;
    const visited = new Set<string>();
    while (current.$ref) {
      if (visited.has(current.$ref)) break;
      visited.add(current.$ref);
      const resolved = resolveRef(current.$ref, schemas);
      if (!resolved) break;
      current = resolved;
    }
    const rows: string[] = [];
    if (current.properties) {
      rows.push('| 字段 | 类型 | 必填 | 说明 |');
      rows.push('|------|------|------|------|');
      rows.push(...renderSchemaRows(current, schemas, 0, visited, ''));
    } else if (current.type === 'array' && current.items) {
      rows.push('| 字段 | 类型 | 必填 | 说明 |');
      rows.push('|------|------|------|------|');
      rows.push(...renderSchemaRows(current, schemas, 0, visited, ''));
    }
    if (rows.length > 2) {
      sections.push(header.concat(rows).join('\n'));
    } else if (current.description) {
      sections.push(header.concat([current.description]).join('\n'));
    }
  }
  return sections.join('\n\n');
}

// ─── BeisenSource class ─────────────────────────────────────────────────────

interface BeisenCatalogEntry extends DocEntry {
  /** 应用 open_app_id，用于详情接口（非必需但保留） */
  platformId?: string;
}

export class BeisenSource implements DocSource {
  id = 'beisen';
  name = '北森 iTalent 开放平台';

  private client: AxiosInstance;
  private requestCount = 0;
  private folderErrorCount = 0;
  private skippedExternal = 0;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${BASE_URL}/?_qrt=html`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 100 === 0) {
      console.log(`[beisen] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  /** 获取顶层应用菜单 */
  private async fetchLevel1Menus(): Promise<BeisenLevel1Menu[]> {
    await this.throttle();
    const resp = await this.client.get<BeisenResponse<BeisenLevel1Menu[]>>(
      '/api/OpenDocumentMenu/GetLevel1Menus',
      { params: { __t: Date.now() } },
    );
    if (resp.data.errcode !== 0) {
      throw new Error(`获取顶层菜单失败: ${resp.data.errmsg}`);
    }
    return resp.data.data;
  }

  /** 获取某应用的一级目录 */
  private async fetchAppMenus(openAppId: string): Promise<BeisenMenuNode[]> {
    await this.throttle();
    const resp = await this.client.get<BeisenResponse<BeisenMenuNode[]>>(
      '/api/OpenDocumentMenu/GetMenusByAppId',
      {
        params: {
          open_system_application_id: openAppId,
          __t: Date.now(),
        },
      },
    );
    if (resp.data.errcode !== 0) {
      throw new Error(`获取应用菜单失败(${openAppId}): ${resp.data.errmsg}`);
    }
    return resp.data.data || [];
  }

  /** 展开文件夹 */
  private async fetchFolderMenus(folderId: string, openAppId: string): Promise<BeisenMenuNode[]> {
    await this.throttle();
    const resp = await this.client.get<BeisenResponse<BeisenMenuNode[]>>(
      '/api/OpenDocumentMenu/GetMenusByfolderId',
      {
        params: {
          folderId,
          open_system_application_id: openAppId,
          __t: Date.now(),
        },
      },
    );
    if (resp.data.errcode !== 0) {
      throw new Error(`获取文件夹失败(${folderId}): ${resp.data.errmsg}`);
    }
    return resp.data.data || [];
  }

  /** 获取接口详情 */
  private async fetchInterfaceDetail(interfaceId: string): Promise<BeisenDocDetail> {
    await this.throttle();
    const resp = await this.client.get<BeisenResponse<BeisenDocDetail>>(
      '/api/OpenDocument/Get',
      {
        params: {
          id: interfaceId,
          platform: 1,
          __t: Date.now(),
        },
      },
    );
    if (resp.data.errcode !== 0) {
      throw new Error(`获取接口详情失败(${interfaceId}): ${resp.data.errmsg}`);
    }
    return resp.data.data;
  }

  /**
   * 递归展开一棵目录树，把所有 type=3 接口叶子节点转成 DocEntry
   */
  private async walkMenuTree(
    appName: string,
    openAppId: string,
    nodes: BeisenMenuNode[],
    parentPath: string[],
    entries: BeisenCatalogEntry[],
  ): Promise<void> {
    for (const node of nodes) {
      if (!node.visible || node.isDelete) continue;

      const currentPath = [...parentPath, node.name];

      if (node.type === 3 && node.openInterfaceId) {
        // API 接口叶子
        entries.push({
          path: currentPath.join('/'),
          title: node.name,
          docType: 'api_reference',
          sourceUrl: `${BASE_URL}/?_qrt=html#/open-document?menu=document-center&interfaceId=${node.openInterfaceId}`,
          platformId: node.openInterfaceId,
        });
      } else if (node.type === 1) {
        // 文件夹 - 递归展开
        try {
          const children = await this.fetchFolderMenus(node.key, openAppId);
          await this.walkMenuTree(appName, openAppId, children, currentPath, entries);
        } catch (error) {
          this.folderErrorCount++;
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[beisen] 文件夹展开失败 ${currentPath.join('/')}: ${msg}`);
        }
      } else if (node.type === 2) {
        // 外链文档 - 跳过（指向需登录的 users.italent.cn）
        this.skippedExternal++;
      }
    }
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[beisen] 获取顶层应用菜单...');
    const apps = await this.fetchLevel1Menus();
    console.log(`[beisen] 发现 ${apps.length} 个业务模块`);

    const entries: BeisenCatalogEntry[] = [];

    for (const app of apps) {
      try {
        const menus = await this.fetchAppMenus(app.open_app_id);
        const before = entries.length;
        await this.walkMenuTree(app.name, app.open_app_id, menus, [app.name], entries);
        console.log(`[beisen] ${app.name}: ${entries.length - before} 个接口`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[beisen] 处理模块 ${app.name} 失败: ${msg}`);
      }
    }

    console.log(
      `[beisen] 目录加载完成: ${entries.length} 个接口 (跳过外链文档 ${this.skippedExternal} 个, 文件夹错误 ${this.folderErrorCount} 个)`,
    );
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const interfaceId = entry.platformId;
    if (!interfaceId) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    const detail = await this.fetchInterfaceDetail(interfaceId);

    const sections: string[] = [];

    // 标题
    sections.push(`# ${detail.interface_name || entry.title}`);

    // 基础信息列表
    const basics: string[] = [];
    if (detail.http_method && detail.interface_url) {
      const fullUrl = detail.interface_url.startsWith('http')
        ? detail.interface_url
        : `https://${detail.interface_url}`;
      basics.push(`**请求方式**：${detail.http_method.toUpperCase()} ${fullUrl}`);
    } else if (detail.interface_url) {
      const fullUrl = detail.interface_url.startsWith('http')
        ? detail.interface_url
        : `https://${detail.interface_url}`;
      basics.push(`**请求地址**：${fullUrl}`);
    }
    if (detail.resouce_title) basics.push(`**所属资源**：${detail.resouce_title}`);
    if (detail.limit_desc) basics.push(`**调用限制**：${detail.limit_desc}`);
    if (detail.permission_desc) basics.push(`**权限说明**：${detail.permission_desc}`);
    if (basics.length > 0) sections.push(basics.join('\n'));

    // 使用场景（可能含 HTML）
    const sceneMd = normalizeRichText(detail.scene);
    if (sceneMd) {
      sections.push('## 使用场景');
      sections.push(sceneMd);
    }

    // 注意事项（可能含 HTML）
    const warningMd = normalizeRichText(detail.warning);
    if (warningMd) {
      sections.push('## 注意事项');
      sections.push(warningMd);
    }

    // 提示（HTML）
    const tipsMd = normalizeRichText(detail.tips);
    if (tipsMd) {
      sections.push('## 提示');
      sections.push(tipsMd);
    }

    // 请求参数（OpenAPI Schema → 表格）
    if (detail.parameter) {
      const paramTable = renderOpenApiSchema(detail.parameter, 'parameter');
      if (paramTable) {
        sections.push('## 请求参数');
        sections.push(paramTable);
      }
    }

    // 请求示例
    if (detail.parameter_example) {
      sections.push('## 请求示例');
      sections.push('```json');
      sections.push(detail.parameter_example.replace(/\r\n/g, '\n').trim());
      sections.push('```');
    }

    // 响应参数
    if (detail.response) {
      const respTable = renderOpenApiSchema(detail.response, 'response');
      if (respTable) {
        sections.push('## 响应参数');
        sections.push(respTable);
      }
    }

    // 响应示例
    if (detail.response_example) {
      sections.push('## 响应示例');
      sections.push('```json');
      sections.push(detail.response_example.replace(/\r\n/g, '\n').trim());
      sections.push('```');
    }

    // 错误码示例
    if (detail.exception_example) {
      sections.push('## 错误示例');
      sections.push('```json');
      sections.push(detail.exception_example.replace(/\r\n/g, '\n').trim());
      sections.push('```');
    }

    // 错误码
    if (detail.error_code) {
      sections.push('## 错误码');
      sections.push(detail.error_code.replace(/\r\n/g, '\n').trim());
    }

    const markdown = sections
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    const lastUpdated = parseBeisenTime(detail.modified_time);
    if (lastUpdated) metadata.lastUpdated = lastUpdated;

    // 从错误码文本提取错误码列表（每行第一个 token 是数字）
    const errorCodes: Array<{ code: string; message?: string; description?: string }> = [];
    if (detail.error_code) {
      for (const line of detail.error_code.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d{3,5})[\s]+(.*)$/);
        if (m) {
          errorCodes.push({ code: m[1], description: m[2].trim() });
        }
      }
    }

    return {
      markdown,
      apiPath: detail.interface_url || undefined,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
