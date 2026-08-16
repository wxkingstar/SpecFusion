/**
 * 冒烟测试：验证插件模块可加载、apply 能注册 skill 与工具，且工具可端到端
 * 调用 SpecFusion 云端 API。
 *
 * 运行：node smoke-test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apply, name, inject, Config, SPECFUSION_SKILL } from "./lib/index.js";
import { createClient, DEFAULT_BASE_URL } from "./lib/client.js";
import { registerTools } from "./lib/tools.js";

// ---- 0. bundle 声明（dsh plugin add 依赖它把插件挂进 profile 层）----
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "package.json 必须声明 dsh.bundle.patch");
assert.ok(
  pkg.files.includes("cordis.patch.yml"),
  "files 必须包含 cordis.patch.yml，否则发布后缺失",
);

// ---- 1. 模块导出 ----
assert.equal(name, "specfusion-dsh");
assert.deepEqual(inject, ["skills", "tools"]);
assert.equal(typeof apply, "function");
assert.ok(Config, "Config 已导出");
assert.equal(SPECFUSION_SKILL.name, "specfusion");
assert.ok(SPECFUSION_SKILL.content.length > 0, "skill content 非空");

// ---- 2. apply() 注册检查（mock services）----
const registeredSkills = [];
const registeredTools = [];
const ctx = {
  skills: { register: (skill) => { registeredSkills.push(skill); return () => {}; } },
  tools: { register: (def) => { registeredTools.push(def); return () => {}; } },
};
apply(ctx, { baseUrl: DEFAULT_BASE_URL });

assert.equal(registeredSkills.length, 1, "应注册 1 个 skill");
const skill = registeredSkills[0];
assert.equal(skill.name, "specfusion");
assert.equal(typeof skill.description, "string");
assert.ok(skill.description.length > 0);
assert.equal(typeof skill.content, "string");
assert.equal(typeof skill.source, "string");

assert.equal(registeredTools.length, 5, "应注册 5 个工具");
const expected = [
  "specfusion_search",
  "specfusion_doc",
  "specfusion_sources",
  "specfusion_categories",
  "specfusion_recent",
];
const names = registeredTools.map((t) => t.name);
assert.deepEqual(names, expected, `工具名应为 ${expected.join(", ")}`);
for (const def of registeredTools) {
  assert.equal(typeof def.description, "string");
  assert.ok(def.output && def.output.schema, `${def.name} 有 output.schema`);
  assert.equal(typeof def.execute, "function", `${def.name} 有 execute`);
}

// ---- 3. 端到端：真实 HTTP 调用（走 registerTools + defineTool + client）----
const captured = [];
registerTools({ tools: { register: (def) => { captured.push(def); return () => {}; } } }, createClient());

const search = captured.find((t) => t.name === "specfusion_search");
const sources = captured.find((t) => t.name === "specfusion_sources");
const fakeExec = { signal: new AbortController().signal };

const searchResult = await search.execute(
  { q: "发送应用消息", source: "wecom", limit: 2 },
  fakeExec,
);
assert.ok(searchResult.includes("搜索结果"), "search 返回 Markdown 结果");
console.log("---- specfusion_search 结果（截断）----");
console.log(searchResult.slice(0, 400));
console.log();

const sourcesResult = await sources.execute({}, fakeExec);
assert.ok(sourcesResult.length > 0, "sources 返回非空");
console.log("---- specfusion_sources 结果（截断）----");
console.log(sourcesResult.slice(0, 400));

console.log("\n✅ smoke-test 全部通过");
