/**
 * SpecFusion DeepSeek Harness 插件。
 *
 * 一个 Cordis 插件，同时：
 *   - 注入 `skills`，注册运行时 skill `specfusion`；
 *   - 注入 `tools`，注册 5 个原生工具（specfusion_search / specfusion_doc /
 *     specfusion_sources / specfusion_categories / specfusion_recent）。
 *
 * 安装：`dsh plugin --profile web add @wxkingstar/specfusion-dsh`
 *
 * @module @wxkingstar/specfusion-dsh
 */

import z from "@deepseek-ai/schemastery";
import { BASE_URL_ENV, DEFAULT_BASE_URL, createClient } from "./client.js";
import { SPECFUSION_SKILL } from "./skill.js";
import { registerTools } from "./tools.js";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "specfusion-dsh";

/** 本插件依赖的 ctx 服务。 */
export const inject = ["skills", "tools"];

/** 插件配置：baseUrl 可被 cordis.patch.yml 或环境变量覆盖。 */
export const Config = z.object({
  baseUrl: z
    .string()
    .description("SpecFusion API base URL，如 https://specfusion.inagora.org/api")
    .default(DEFAULT_BASE_URL),
});

/**
 * Cordis 插件入口：注册 skill 与工具。
 * @param {object} ctx Cordis 上下文（含 ctx.skills / ctx.tools）。
 * @param {{ baseUrl?: string }} [config] 解析后的配置。
 */
export function apply(ctx, config = {}) {
  const baseUrl =
    config.baseUrl || process.env[BASE_URL_ENV] || DEFAULT_BASE_URL;
  const client = createClient(baseUrl);

  ctx.skills.register(SPECFUSION_SKILL);
  registerTools(ctx, client);
}

export { BASE_URL_ENV, DEFAULT_BASE_URL, createClient } from "./client.js";
export { SPECFUSION_SKILL } from "./skill.js";
export { registerTools } from "./tools.js";
