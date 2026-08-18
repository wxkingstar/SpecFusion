import axios, { type AxiosInstance } from 'axios';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.volcengine.com';
const API_BASE = `${BASE_URL}/api/common`;
const SERVICE_CODE = 'ecs';
const API_VERSION = '2020-04-01';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 请求间隔（ms） */
const REQUEST_DELAY = 200;

const VIEW_BASE = `${BASE_URL}/api-docs/view/overview`;

// ─── API response interfaces ────────────────────────────────────────────────

interface VolcResponse<T> {
  ResponseMetadata: { RequestID: string };
  Result: T;
}

interface GroupedApisResult {
  Groups: ApiGroup[];
}

interface ApiGroup {
  Name: string;
  Apis: ApiEntry[];
}

interface ApiEntry {
  UniversalID: string;
  ServiceCode: string;
  Action: string;
  NameCn: string;
  ApiGroup: string;
  Version: string;
  OperationType: number;
  Description: string;
  IsBypass: number;
}

interface SwaggerResult {
  Api: OpenAPISpec;
}

interface OpenAPISpec {
  openapi: string;
  info: { title?: string; description?: string };
  paths: Record<string, Record<string, OperationSpec>>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface OperationSpec {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: { content?: Record<string, { schema?: SchemaObject }> };
  responses?: Record<string, ResponseObject>;
  'x-attentions'?: string;
  'x-usage-scenario'?: string;
  'x-sort-params'?: string[];
}

interface ParameterObject {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  'x-sort-params'?: string[];
}

interface SchemaObject {
  type?: string;
  format?: string;
  description?: string;
  example?: unknown;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject | SchemaObject[];
  $ref?: string;
  required?: string[];
  enum?: unknown[];
  'x-sort-params'?: string[];
}

// ─── Utility helpers ────────────────────────────────────────────────────────


function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── OpenAPI → Markdown conversion ──────────────────────────────────────────

function resolveRef(spec: OpenAPISpec, ref: string): SchemaObject | undefined {
  // #/components/schemas/Foo → components.schemas.Foo
  const parts = ref.replace('#/', '').split('/');
  let obj: unknown = spec;
  for (const p of parts) {
    if (obj && typeof obj === 'object') {
      obj = (obj as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return obj as SchemaObject | undefined;
}

function schemaTypeName(schema: SchemaObject, spec: OpenAPISpec): string {
  if (schema.$ref) {
    const resolved = resolveRef(spec, schema.$ref);
    const refName = schema.$ref.split('/').pop() || '';
    return resolved?.type === 'object' ? `Object（${refName}）` : refName;
  }
  if (schema.type === 'array') {
    const items = schema.items;
    if (items && !Array.isArray(items)) {
      if (items.$ref) return `Array<${items.$ref.split('/').pop()}>`;
      return `Array<${items.type || 'String'}>`;
    }
    return 'Array';
  }
  if (schema.type === 'integer') return schema.format || 'Integer';
  if (schema.type === 'number') return schema.format || 'Number';
  if (schema.type === 'boolean') return 'Boolean';
  return schema.type || 'String';
}

function renderParamTable(
  params: ParameterObject[],
  sortOrder?: string[],
): string {
  const sorted = sortOrder
    ? [...params].sort((a, b) => {
        const ia = sortOrder.indexOf(a.name);
        const ib = sortOrder.indexOf(b.name);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      })
    : params;

  const lines: string[] = [];
  lines.push('| 参数名 | 类型 | 是否必填 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  for (const p of sorted) {
    const type = p.schema?.type || 'String';
    const required = p.required ? '是' : '否';
    const desc = escapeCell(p.description || p.schema?.description || '');
    lines.push(`| ${p.name} | ${escapeCell(type)} | ${required} | ${desc} |`);
  }
  return lines.join('\n');
}

function renderSchemaProperties(
  schema: SchemaObject,
  spec: OpenAPISpec,
  sortOrder?: string[],
): string {
  const props = schema.properties;
  if (!props) return '';

  const keys = sortOrder
    ? [...Object.keys(props)].sort((a, b) => {
        const ia = sortOrder.indexOf(a);
        const ib = sortOrder.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      })
    : Object.keys(props);

  const lines: string[] = [];
  lines.push('| 参数名 | 类型 | 说明 |');
  lines.push('| --- | --- | --- |');

  for (const key of keys) {
    const prop = props[key];
    const type = schemaTypeName(prop, spec);
    const desc = escapeCell(prop.description || '');
    lines.push(`| ${key} | ${escapeCell(type)} | ${desc} |`);
  }

  return lines.join('\n');
}

function renderResponseSchema(
  respObj: ResponseObject,
  spec: OpenAPISpec,
): string {
  const sections: string[] = [];
  const content = respObj.content;
  if (!content) return '';

  for (const [, mediaObj] of Object.entries(content)) {
    const schema = mediaObj.schema;
    if (!schema || !schema.properties) continue;

    const sortOrder = respObj['x-sort-params'] || schema['x-sort-params'];
    const table = renderSchemaProperties(schema, spec, sortOrder);
    if (table) sections.push(table);

    // Render nested object schemas referenced by $ref
    for (const [, prop] of Object.entries(schema.properties)) {
      const ref = prop.$ref || (prop.items && !Array.isArray(prop.items) ? prop.items.$ref : undefined);
      if (ref) {
        const resolved = resolveRef(spec, ref);
        if (resolved?.properties) {
          const refName = ref.split('/').pop() || '';
          sections.push(`\n**${refName}**\n`);
          const nestedSort = resolved['x-sort-params'];
          sections.push(renderSchemaProperties(resolved, spec, nestedSort));
        }
      }
    }
  }

  return sections.join('\n');
}

function renderErrorCodes(
  errResp: ResponseObject,
): Array<{ code: string; message?: string; description?: string }> {
  const codes: Array<{ code: string; message?: string; description?: string }> = [];
  const content = errResp.content;
  if (!content) return codes;

  for (const [, mediaObj] of Object.entries(content)) {
    const items = mediaObj.schema?.items as unknown;
    if (Array.isArray(items)) {
      for (const item of items as Array<Record<string, unknown>>) {
        if (item.code) {
          codes.push({
            code: String(item.code),
            message: item.message as string | undefined,
            description: item.description as string | undefined,
          });
        }
      }
    }
  }
  return codes;
}

function swaggerToMarkdown(
  action: string,
  nameCn: string,
  groupName: string,
  apiDescription: string,
  swagger: OpenAPISpec,
): { markdown: string; errorCodes: Array<{ code: string; message?: string; description?: string }> } {
  const sections: string[] = [];

  // Find the operation
  const pathEntry = Object.entries(swagger.paths)[0];
  if (!pathEntry) {
    return { markdown: `# ${action}（${nameCn}）\n\n${apiDescription}\n`, errorCodes: [] };
  }

  const [apiPath, methods] = pathEntry;
  const method = Object.keys(methods)[0]?.toUpperCase() || 'GET';
  const op = Object.values(methods)[0];

  // Title
  sections.push(`# ${action}（${nameCn}）\n`);

  // Meta
  sections.push(`- **分组**：${groupName}`);
  sections.push(`- **接口路径**：${method} ${apiPath}`);
  sections.push(`- **API版本**：${API_VERSION}`);
  sections.push('');

  // Description
  if (op.description) {
    sections.push(op.description);
    sections.push('');
  }

  // Usage scenario
  if (op['x-usage-scenario']) {
    sections.push('## 使用场景\n');
    sections.push(op['x-usage-scenario']);
    sections.push('');
  }

  // Attentions
  if (op['x-attentions']) {
    sections.push('## 注意事项\n');
    sections.push(op['x-attentions']);
    sections.push('');
  }

  // Request parameters
  if (op.parameters && op.parameters.length > 0) {
    sections.push('## 请求参数\n');
    sections.push(renderParamTable(op.parameters, op['x-sort-params']));
    sections.push('');
  }

  // Request body (for POST)
  if (op.requestBody?.content) {
    sections.push('## 请求体\n');
    for (const [, mediaObj] of Object.entries(op.requestBody.content)) {
      const schema = mediaObj.schema;
      if (schema?.properties) {
        const sortOrder = schema['x-sort-params'];
        sections.push(renderSchemaProperties(schema, swagger, sortOrder));
      } else if (schema?.$ref) {
        const resolved = resolveRef(swagger, schema.$ref);
        if (resolved?.properties) {
          const sortOrder = resolved['x-sort-params'];
          sections.push(renderSchemaProperties(resolved, swagger, sortOrder));
        }
      }
    }
    sections.push('');
  }

  // Response
  let errorCodes: Array<{ code: string; message?: string; description?: string }> = [];
  const resp200 = op.responses?.['200'];
  if (resp200) {
    sections.push('## 返回参数\n');
    const respMd = renderResponseSchema(resp200, swagger);
    if (respMd) sections.push(respMd);
    sections.push('');
  }

  // Error codes
  const errResp = op.responses?.['x-error-code'];
  if (errResp) {
    errorCodes = renderErrorCodes(errResp);
    if (errorCodes.length > 0) {
      sections.push('## 错误码\n');
      sections.push('| 错误码 | 错误信息 |');
      sections.push('| --- | --- |');
      for (const ec of errorCodes) {
        sections.push(`| ${ec.code} | ${escapeCell(ec.message || '')} |`);
      }
      sections.push('');
    }
  }

  const markdown = collapseBlankLines(sections.join('\n')).trim();
  return { markdown, errorCodes };
}

// ─── VolcengineEcsSource class ──────────────────────────────────────────────

export class VolcengineEcsSource implements DocSource {
  id = 'volcengine-ecs';
  name = '火山引擎云服务器';

  private client: AxiosInstance;
  private requestCount = 0;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${VIEW_BASE}?serviceCode=${SERVICE_CODE}&version=${API_VERSION}`,
      },
      timeout: 30_000,
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount % 20 === 0) {
      console.log(`[volcengine-ecs] 已发送 ${this.requestCount} 个请求`);
    }
    await delay(REQUEST_DELAY);
  }

  // ─── API calls ─────────────────────────────────────────────────────────

  /** 获取分组的 API 目录 */
  private async fetchGroupedApis(): Promise<ApiGroup[]> {
    const resp = await this.client.get<VolcResponse<GroupedApisResult>>(
      '/docs/grouped-apis',
      {
        params: {
          ServiceCode: SERVICE_CODE,
          Version: API_VERSION,
          APIVersion: API_VERSION,
        },
      },
    );
    return resp.data.Result.Groups;
  }

  /** 获取单个 API 的 Swagger 定义 */
  private async fetchApiSwagger(action: string): Promise<OpenAPISpec> {
    await this.throttle();
    const resp = await this.client.get<VolcResponse<SwaggerResult>>(
      '/explorer/api-swagger',
      {
        params: {
          ServiceCode: SERVICE_CODE,
          Version: API_VERSION,
          APIVersion: API_VERSION,
          ActionName: action,
        },
      },
    );
    return resp.data.Result.Api;
  }

  // ─── DocSource interface ───────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    console.log('[volcengine-ecs] 获取 API 目录...');
    const groups = await this.fetchGroupedApis();
    console.log(`[volcengine-ecs] 发现 ${groups.length} 个分组`);

    const entries: DocEntry[] = [];

    for (const group of groups) {
      console.log(`[volcengine-ecs]   ${group.Name}: ${group.Apis.length} 个 API`);

      for (const api of group.Apis) {
        entries.push({
          path: `${group.Name}/${api.Action}`,
          title: `${api.Action}（${api.NameCn}）`,
          apiPath: `/${api.Action}`,
          docType: 'api_reference',
          sourceUrl: `${VIEW_BASE}?serviceCode=${SERVICE_CODE}&version=${API_VERSION}&action=${api.Action}`,
          platformId: api.Action,
        });
      }
    }

    console.log(`[volcengine-ecs] 目录加载完成: ${groups.length} 个分组, ${entries.length} 个 API`);
    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const action = entry.platformId;
    if (!action) {
      throw new Error(`Missing platformId for entry: ${entry.title}`);
    }

    // Extract group name and Chinese name from path/title
    const groupName = entry.path.split('/')[0] || '';
    const nameCn = entry.title.match(/（(.+)）/)?.[1] || '';
    const apiDescription = '';

    const swagger = await this.fetchApiSwagger(action);
    const { markdown, errorCodes } = swaggerToMarkdown(
      action,
      nameCn,
      groupName,
      apiDescription,
      swagger,
    );

    // Tokenize for FTS
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    return {
      markdown,
      apiPath: `/${action}`,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}
