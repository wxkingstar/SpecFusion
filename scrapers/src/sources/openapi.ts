import type { DocSource, DocEntry, DocContent } from '../types.js';
import axios from 'axios';
import * as yaml from 'js-yaml';
import * as swagger2openapi from 'swagger2openapi';

// OpenAPI 类型简写（非完整类型，仅覆盖本文件使用到的字段）
interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, SchemaObject> };
  definitions?: Record<string, SchemaObject>; // Swagger 2.0
}

interface OperationObject {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
}

interface ParameterObject {
  name: string;
  in: string; // path | query | header | cookie
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
  type?: string; // Swagger 2.0 遗留
}

interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  schema?: SchemaObject; // Swagger 2.0 遗留
}

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  additionalProperties?: boolean | SchemaObject;
  nullable?: boolean;
  example?: unknown;
  default?: unknown;
  title?: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const MAX_REF_DEPTH = 5;

/**
 * OpenAPI 3.x 通用适配器
 * 解析 OpenAPI spec 并生成结构化 Markdown 文档
 */
export class OpenAPISource implements DocSource {
  id: string;
  name: string;
  private specUrl: string;
  private cachedSpec: OpenAPISpec | null = null;

  constructor(specUrl: string, sourceId: string, sourceName: string) {
    this.specUrl = specUrl;
    this.id = sourceId;
    this.name = sourceName;
  }

  async fetchCatalog(): Promise<DocEntry[]> {
    const spec = await this.loadSpec();
    const entries: DocEntry[] = [];
    const paths = spec.paths || {};

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method] as OperationObject | undefined;
        if (!operation) continue;

        const upperMethod = method.toUpperCase();
        const tag = operation.tags?.[0] || 'default';
        const title = operation.summary || `${upperMethod} ${path}`;
        const docPath = `${tag}/${upperMethod} ${path}`;

        entries.push({
          path: docPath,
          title,
          apiPath: `${upperMethod} ${path}`,
          docType: 'api_reference',
          sourceUrl: this.specUrl,
          platformId: operation.operationId || `${method}-${path}`,
        });
      }
    }

    return entries;
  }

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const spec = await this.loadSpec();
    const apiPath = entry.apiPath || '';
    const spaceIdx = apiPath.indexOf(' ');
    if (spaceIdx === -1) {
      return { markdown: `# ${entry.title}\n\n无法解析接口路径。`, apiPath };
    }

    const method = apiPath.substring(0, spaceIdx).toLowerCase();
    const path = apiPath.substring(spaceIdx + 1);
    const operation = spec.paths?.[path]?.[method] as OperationObject | undefined;

    if (!operation) {
      return { markdown: `# ${entry.title}\n\n在 spec 中未找到该接口定义。`, apiPath };
    }

    const md = this.renderOperation(method, path, operation, spec);
    const errorCodes = this.extractErrorCodes(operation);

    return {
      markdown: md,
      apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
    };
  }

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    // OpenAPI spec 不支持增量，全量返回
    return this.fetchCatalog();
  }

  // ─── 内部方法 ───

  /**
   * 加载并解析 OpenAPI spec，支持 JSON/YAML，自动转换 Swagger 2.0
   */
  private async loadSpec(): Promise<OpenAPISpec> {
    if (this.cachedSpec) return this.cachedSpec;

    const resp = await axios.get(this.specUrl, {
      headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
      responseType: 'text',
      timeout: 30_000,
    });

    let raw: string = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    let spec: OpenAPISpec;

    // 尝试 JSON 解析，失败则 YAML
    try {
      spec = JSON.parse(raw);
    } catch {
      spec = yaml.load(raw) as OpenAPISpec;
    }

    if (!spec || typeof spec !== 'object') {
      throw new Error(`无法解析 OpenAPI spec: ${this.specUrl}`);
    }

    // Swagger 2.0 → OpenAPI 3.0 转换
    if (spec.swagger === '2.0') {
      const converted = await swagger2openapi.convertObj(spec, {
        patch: true,
        warnOnly: true,
      });
      spec = converted.openapi as OpenAPISpec;
    }

    this.cachedSpec = spec;
    return spec;
  }

  /**
   * 递归解析 $ref 引用
   */
  private resolveRef(ref: string, spec: OpenAPISpec, depth: number = 0, visited: Set<string> = new Set()): SchemaObject {
    if (depth >= MAX_REF_DEPTH || visited.has(ref)) {
      const name = ref.split('/').pop() || ref;
      return { description: `[见定义: ${name}]` };
    }

    visited.add(ref);

    // 只处理本文件内 $ref，如 #/components/schemas/User
    if (!ref.startsWith('#/')) {
      return { description: `[外部引用: ${ref}]` };
    }

    const parts = ref.replace('#/', '').split('/');
    let current: any = spec;
    for (const part of parts) {
      current = current?.[part];
      if (current === undefined) {
        return { description: `[未找到: ${ref}]` };
      }
    }

    const resolved = current as SchemaObject;

    // 如果解析结果本身还有 $ref，继续解析
    if (resolved.$ref) {
      return this.resolveRef(resolved.$ref, spec, depth + 1, visited);
    }

    return resolved;
  }

  /**
   * 解析 schema，处理 $ref
   */
  private resolveSchema(schema: SchemaObject, spec: OpenAPISpec, depth: number = 0, visited: Set<string> = new Set()): SchemaObject {
    if (!schema) return {};
    if (schema.$ref) {
      return this.resolveRef(schema.$ref, spec, depth, visited);
    }
    return schema;
  }

  /**
   * 将 operation 渲染为 Markdown
   */
  private renderOperation(method: string, path: string, op: OperationObject, spec: OpenAPISpec): string {
    const lines: string[] = [];
    const upperMethod = method.toUpperCase();

    // 标题
    const title = op.summary ? `${upperMethod} ${path} - ${op.summary}` : `${upperMethod} ${path}`;
    lines.push(`# ${title}`);
    lines.push('');

    if (op.deprecated) {
      lines.push('> **已弃用**：此接口已被标记为弃用。');
      lines.push('');
    }

    if (op.description) {
      lines.push(op.description);
      lines.push('');
    }

    // 请求参数
    lines.push('## 请求参数');
    lines.push('');

    const params = op.parameters || [];
    const grouped: Record<string, ParameterObject[]> = {};
    for (const p of params) {
      const loc = p.in || 'query';
      if (!grouped[loc]) grouped[loc] = [];
      grouped[loc].push(p);
    }

    const locationLabels: Record<string, string> = {
      path: 'Path 参数',
      query: 'Query 参数',
      header: 'Header 参数',
      cookie: 'Cookie 参数',
    };

    const locationOrder = ['path', 'query', 'header', 'cookie'];
    let hasAnyParam = false;

    for (const loc of locationOrder) {
      const group = grouped[loc];
      if (!group || group.length === 0) continue;
      hasAnyParam = true;

      lines.push(`### ${locationLabels[loc] || loc}`);
      lines.push('');
      lines.push('| 参数 | 类型 | 必填 | 说明 |');
      lines.push('|------|------|------|------|');

      for (const p of group) {
        const resolved = p.schema ? this.resolveSchema(p.schema, spec) : {};
        const typeStr = this.getTypeString(resolved);
        const required = p.required ? '是' : '否';
        const desc = this.escapeTableCell(p.description || resolved.description || '');
        lines.push(`| ${p.name} | ${typeStr} | ${required} | ${desc} |`);
      }
      lines.push('');
    }

    if (!hasAnyParam) {
      lines.push('（无）');
      lines.push('');
    }

    // 请求体
    if (op.requestBody) {
      lines.push('### 请求体');
      lines.push('');

      if (op.requestBody.description) {
        lines.push(op.requestBody.description);
        lines.push('');
      }

      const content = op.requestBody.content || {};
      const mediaType = content['application/json'] || content[Object.keys(content)[0] || ''];

      if (mediaType?.schema) {
        const resolved = this.resolveSchema(mediaType.schema, spec);
        const table = this.renderSchemaTable(resolved, spec);
        if (table) {
          lines.push(table);
        } else {
          lines.push(this.renderSchemaBlock(resolved, spec, 0, new Set()));
        }
      }
      lines.push('');
    }

    // 响应
    lines.push('## 响应');
    lines.push('');

    const responses = op.responses || {};
    for (const [code, resp] of Object.entries(responses)) {
      const response = resp as ResponseObject;
      const desc = response.description || '';
      lines.push(`### ${code}${desc ? ` - ${desc}` : ''}`);
      lines.push('');

      const respContent = response.content || {};
      const respMedia = respContent['application/json'] || respContent[Object.keys(respContent)[0] || ''];

      if (respMedia?.schema) {
        const resolved = this.resolveSchema(respMedia.schema, spec);
        lines.push(this.renderSchemaBlock(resolved, spec, 0, new Set()));
        lines.push('');
      } else if (response.schema) {
        // Swagger 2.0 遗留格式
        const resolved = this.resolveSchema(response.schema, spec);
        lines.push(this.renderSchemaBlock(resolved, spec, 0, new Set()));
        lines.push('');
      }
    }

    return lines.join('\n').trimEnd();
  }

  /**
   * 渲染 schema 为参数表格（仅适用于 object 类型顶层属性）
   */
  private renderSchemaTable(schema: SchemaObject, spec: OpenAPISpec): string | null {
    const resolved = this.resolveSchema(schema, spec);

    // allOf 合并
    let merged = resolved;
    if (resolved.allOf) {
      merged = this.mergeAllOf(resolved.allOf, spec);
    }

    if (merged.type !== 'object' && !merged.properties) return null;

    const props = merged.properties || {};
    const requiredSet = new Set(merged.required || []);

    if (Object.keys(props).length === 0) return null;

    const lines: string[] = [];
    lines.push('| 参数 | 类型 | 必填 | 说明 |');
    lines.push('|------|------|------|------|');

    for (const [name, propSchema] of Object.entries(props)) {
      const resolvedProp = this.resolveSchema(propSchema, spec);
      const typeStr = this.getTypeString(resolvedProp);
      const required = requiredSet.has(name) ? '是' : '否';
      const desc = this.escapeTableCell(resolvedProp.description || propSchema.description || '');
      lines.push(`| ${name} | ${typeStr} | ${required} | ${desc} |`);
    }

    return lines.join('\n');
  }

  /**
   * 渲染 schema 为 Markdown 块（递归）
   */
  private renderSchemaBlock(schema: SchemaObject, spec: OpenAPISpec, depth: number, visited: Set<string>): string {
    if (depth > MAX_REF_DEPTH) return '（嵌套层级过深，省略）';

    // 处理 $ref
    if (schema.$ref) {
      if (visited.has(schema.$ref)) {
        const name = schema.$ref.split('/').pop() || schema.$ref;
        return `[循环引用: ${name}]`;
      }
      const newVisited = new Set(visited);
      newVisited.add(schema.$ref);
      const resolved = this.resolveRef(schema.$ref, spec, depth, newVisited);
      return this.renderSchemaBlock(resolved, spec, depth, newVisited);
    }

    const lines: string[] = [];
    const indent = '  '.repeat(depth);

    // allOf
    if (schema.allOf) {
      const merged = this.mergeAllOf(schema.allOf, spec);
      return this.renderSchemaBlock(merged, spec, depth, visited);
    }

    // oneOf / anyOf
    if (schema.oneOf || schema.anyOf) {
      const variants = schema.oneOf || schema.anyOf || [];
      const label = schema.oneOf ? 'oneOf' : 'anyOf';
      lines.push(`${indent}**${label}** - 以下方式之一：`);
      lines.push('');
      variants.forEach((variant, i) => {
        lines.push(`${indent}**方式${i + 1}：**`);
        lines.push('');
        lines.push(this.renderSchemaBlock(variant, spec, depth + 1, visited));
        lines.push('');
      });
      return lines.join('\n');
    }

    // enum
    if (schema.enum) {
      const enumValues = schema.enum.map(v => `\`${v}\``).join(', ');
      lines.push(`${indent}枚举值: ${enumValues}`);
      if (schema.description) {
        lines.push(`${indent}${schema.description}`);
      }
      return lines.join('\n');
    }

    // array
    if (schema.type === 'array' && schema.items) {
      const resolvedItems = this.resolveSchema(schema.items, spec);
      lines.push(`${indent}类型: array`);
      if (schema.description) {
        lines.push(`${indent}${schema.description}`);
      }
      lines.push(`${indent}元素：`);
      lines.push(this.renderSchemaBlock(resolvedItems, spec, depth + 1, visited));
      return lines.join('\n');
    }

    // object
    if (schema.type === 'object' || schema.properties) {
      const props = schema.properties || {};
      const requiredSet = new Set(schema.required || []);

      if (schema.description && depth > 0) {
        lines.push(`${indent}${schema.description}`);
      }

      for (const [name, propSchema] of Object.entries(props)) {
        const resolvedProp = this.resolveSchema(propSchema, spec);
        const typeStr = this.getTypeString(resolvedProp);
        const req = requiredSet.has(name) ? '（必填）' : '';
        const desc = resolvedProp.description || propSchema.description || '';

        lines.push(`${indent}- **${name}** (${typeStr})${req}${desc ? ': ' + desc : ''}`);

        // 如果属性本身是对象或数组，递归渲染
        if (resolvedProp.properties || resolvedProp.type === 'object') {
          lines.push(this.renderSchemaBlock(resolvedProp, spec, depth + 1, visited));
        } else if (resolvedProp.type === 'array' && resolvedProp.items) {
          const itemResolved = this.resolveSchema(resolvedProp.items, spec);
          if (itemResolved.properties || itemResolved.type === 'object') {
            lines.push(`${indent}  元素：`);
            lines.push(this.renderSchemaBlock(itemResolved, spec, depth + 2, visited));
          }
        } else if (resolvedProp.enum) {
          const enumValues = resolvedProp.enum.map(v => `\`${v}\``).join(', ');
          lines.push(`${indent}  枚举值: ${enumValues}`);
        }
      }

      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const addResolved = this.resolveSchema(schema.additionalProperties as SchemaObject, spec);
        const typeStr = this.getTypeString(addResolved);
        lines.push(`${indent}- **[key: string]** (${typeStr}): 额外属性`);
      }

      return lines.join('\n');
    }

    // 基本类型
    const typeStr = this.getTypeString(schema);
    const desc = schema.description ? `: ${schema.description}` : '';
    return `${indent}类型: ${typeStr}${desc}`;
  }

  /**
   * 合并 allOf 中所有 schema
   */
  private mergeAllOf(schemas: SchemaObject[], spec: OpenAPISpec): SchemaObject {
    const merged: SchemaObject = { type: 'object', properties: {}, required: [] };

    for (const sub of schemas) {
      const resolved = this.resolveSchema(sub, spec);
      if (resolved.properties) {
        Object.assign(merged.properties!, resolved.properties);
      }
      if (resolved.required) {
        merged.required!.push(...resolved.required);
      }
      // 继承描述
      if (resolved.description && !merged.description) {
        merged.description = resolved.description;
      }
    }

    return merged;
  }

  /**
   * 获取类型的可读字符串
   */
  private getTypeString(schema: SchemaObject): string {
    if (!schema) return 'any';

    if (schema.$ref) {
      return schema.$ref.split('/').pop() || 'object';
    }

    if (schema.allOf) return 'object';

    if (schema.oneOf) {
      return schema.oneOf.map(s => this.getTypeString(s)).join(' | ');
    }

    if (schema.anyOf) {
      return schema.anyOf.map(s => this.getTypeString(s)).join(' | ');
    }

    let base = schema.type || 'any';

    if (base === 'array' && schema.items) {
      const itemType = this.getTypeString(schema.items);
      base = `${itemType}[]`;
    }

    if (schema.format) {
      base += ` (${schema.format})`;
    }

    if (schema.nullable) {
      base += ' | null';
    }

    return base;
  }

  /**
   * 转义表格单元格中的管道符和换行
   */
  private escapeTableCell(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  /**
   * 从 responses 中提取非 2xx 状态码
   */
  private extractErrorCodes(op: OperationObject): Array<{ code: string; message?: string; description?: string }> {
    const codes: Array<{ code: string; message?: string; description?: string }> = [];
    const responses = op.responses || {};

    for (const [code, resp] of Object.entries(responses)) {
      // 跳过 2xx 和 default
      if (code.startsWith('2') || code === 'default') continue;

      const response = resp as ResponseObject;
      codes.push({
        code,
        description: response.description || undefined,
      });
    }

    return codes;
  }
}
