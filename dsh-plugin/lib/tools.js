/**
 * SpecFusion 原生工具定义。
 *
 * 用 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册 5 个只读、无状态、并发安全的
 * 工具，直接调用 SpecFusion 云端 API，返回 Markdown 文本。
 *
 * @module @wxkingstar/specfusion-dsh/tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

/** 文档 source 参数的合法取值（含中文提示）。 */
const SOURCE_HINT =
  "wecom/feishu/dingtalk/taobao/xiaohongshu/douyin/wechat-miniprogram/wechat-shop/pinduoduo/youzan/wechat-pay/alipay/jd/shein/dewu/volcengine-ecs/volcengine/bailian/weaver/beisen。不填搜索全部。";

/** 字符串输出：schema + 原样文本渲染。 */
function markdownOutput() {
  return {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  };
}

/**
 * 注册全部 SpecFusion 工具到 `ctx.tools`。
 * @param {{ tools: { register(def: unknown): () => void } }} ctx Cordis 上下文。
 * @param {{ get(path: string, params?: object, signal?: AbortSignal): Promise<string> }} client
 * @returns {() => void} 一次性注销所有工具。
 */
export function registerTools(ctx, client) {
  const disposers = [];

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "specfusion_search",
        description:
          "搜索 SpecFusion 收录的 20 个中国开放平台 API 开发文档。支持接口名、API 路径、错误码、功能概念搜索，返回 Markdown 结果列表（含标题、路径、摘要、文档 ID）。",
        parameters: {
          q: {
            type: "string",
            required: true,
            description:
              "搜索关键词：接口名（发送应用消息）、API 路径（/cgi-bin/message/send）、错误码（60011、40001）、功能概念（客户联系、会话存档）",
          },
          source: { type: "string", description: `文档来源过滤：${SOURCE_HINT}` },
          mode: {
            type: "string",
            description:
              "开发模式过滤（仅企业微信）：internal（自建应用）/ third_party（第三方应用）/ service_provider（服务商代开发）",
          },
          limit: {
            type: "integer",
            description: "返回数量，默认 5，最大 20",
          },
        },
        output: markdownOutput(),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          return client.get(
            "/search",
            { q: args.q, source: args.source, mode: args.mode, limit: args.limit },
            exec.signal,
          );
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "specfusion_doc",
        description:
          "获取 SpecFusion 收录的某篇 API 文档全文，或用 summary=true 获取结构化摘要（约 1-2KB：接口名/路径/参数表/示例）。",
        parameters: {
          doc_id: {
            type: "string",
            required: true,
            description: "文档 ID（来自 specfusion_search 结果中的「文档ID」字段）",
          },
          summary: {
            type: "boolean",
            description: "为 true 时返回结构化摘要；省略或 false 返回全文",
          },
        },
        output: markdownOutput(),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const params = args.summary ? { summary: true } : {};
          return client.get(`/doc/${encodeURIComponent(args.doc_id)}`, params, exec.signal);
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "specfusion_sources",
        description:
          "列出 SpecFusion 已接入的所有文档源（平台）及其文档数量，返回 Markdown 表格。",
        parameters: {},
        output: markdownOutput(),
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
          return client.get("/sources", {}, exec.signal);
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "specfusion_categories",
        description:
          "浏览某平台（或全部平台）的文档分类及数量，帮助在不确定搜索词时发现可用的 API 领域。",
        parameters: {
          source: { type: "string", description: `限定平台：${SOURCE_HINT}` },
        },
        output: markdownOutput(),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          return client.get("/categories", { source: args.source }, exec.signal);
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "specfusion_recent",
        description: "查看 SpecFusion 近期新增或更新的文档，用于追踪文档变更。",
        parameters: {
          source: { type: "string", description: `限定平台：${SOURCE_HINT}` },
          days: { type: "integer", description: "最近 N 天，默认 7，最大 90" },
          limit: { type: "integer", description: "返回数量，默认 20，最大 100" },
        },
        output: markdownOutput(),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          return client.get(
            "/recent",
            { source: args.source, days: args.days, limit: args.limit },
            exec.signal,
          );
        },
      }),
    ),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
