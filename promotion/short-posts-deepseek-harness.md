# DeepSeek Harness 推广短文案

统一落地页：https://github.com/wxkingstar/SpecFusion

## DeepSeek Harness 官方 Discussions

**Title**

`SpecFusion: search 65,602 API docs from 20 Chinese open platforms inside DSH`

**Body**

I built a native DeepSeek Harness plugin for [SpecFusion](https://github.com/wxkingstar/SpecFusion), a full-text index of 65,602 official API docs across 20 Chinese open platforms.

It is aimed at a common problem when coding integrations for WeCom, Feishu, DingTalk, Taobao, Douyin E-commerce, WeChat Pay, Alipay, JD, SHEIN, Volcengine and others: the model can write the request, but the current endpoint, parameters and error codes are scattered across inconsistent and sometimes login-gated doc sites.

The plugin registers one runtime skill and five native, read-only tools:

- `specfusion_search` — search by API name, endpoint path, error code or concept
- `specfusion_doc` — fetch a full document or a structured summary
- `specfusion_sources` — list sources and document counts
- `specfusion_categories` — browse categories
- `specfusion_recent` — inspect recently updated docs

Install it into the web profile:

```bash
dsh plugin --profile web add @wxkingstar/specfusion-dsh
```

Restart `dsh web`, then ask questions such as “How do I send an application message with WeCom?” or “Which parameters does WeChat Pay JSAPI ordering require?” The model can search first, fetch the relevant doc, and continue coding from retrieved context instead of relying on memory.

The tools are stateless and read-only. No platform credentials are required. A hosted index works by default, and the API can also be self-hosted with Docker/Kubernetes.

- GitHub (MIT): https://github.com/wxkingstar/SpecFusion
- npm: https://www.npmjs.com/package/@wxkingstar/specfusion-dsh
- Live search: https://specfusion.kingstar.xin

Feedback and requests for additional platforms are very welcome.

## 知乎想法

DeepSeek Harness 发布约 4 天，官方仓库已经超过 12.9 万 Star。比“又一个 AI 编程客户端”更有意思的是它的架构：Everything is a Plugin。

我把自己维护的 SpecFusion 适配成了 DSH 原生插件：一个 Skill + 5 个只读工具，让 Agent 直接搜索企业微信、飞书、钉钉、淘宝、抖音电商、微信支付、支付宝、京东等 20 个平台的 65,602 篇 API 文档，不用再让人切浏览器复制参数。

安装：`dsh plugin --profile web add @wxkingstar/specfusion-dsh`

项目 MIT 开源，欢迎试用和 Star：
https://github.com/wxkingstar/SpecFusion

## V2EX / Linux.do

**标题**

`[开源] 给 DeepSeek Harness 接了 65,602 篇中国开放平台 API 文档：SpecFusion DSH 插件`

**正文**

DeepSeek Harness 最近的 “Everything is a Plugin” 很火，我把维护中的 SpecFusion 适配成了 DSH 原生插件。

它解决的场景很具体：用 Agent 接企业微信、飞书、钉钉、淘宝、抖音电商、微信支付、支付宝、京东等平台时，不再需要人工切浏览器翻文档。当前索引 20 个平台、65,602 篇官方 API 文档，接口名、路径、错误码、功能概念都能搜。

插件注册 1 个 Skill + 5 个原生只读工具（搜索、取全文、列平台、浏览分类、查看更新），不需要 Bash + curl，也不需要任何开放平台密钥。

安装：

```bash
dsh plugin --profile web add @wxkingstar/specfusion-dsh
```

重启 `dsh web` 后直接问“企业微信怎么发应用消息？”、“微信支付 JSAPI 下单参数有哪些？”即可。

项目 MIT 开源，公共服务零配置，也支持 Docker/K8s 自部署。欢迎 Star，也欢迎提 Issue 告诉我最需要补哪个平台：

https://github.com/wxkingstar/SpecFusion

## X / Twitter 中文

给 DeepSeek Harness 装上了「中国开放平台 API 文档库」：SpecFusion。

20 个平台、65,602 篇文档，注册 1 个 Skill + 5 个 DSH 原生工具；接口名 / 路径 / 错误码都能搜，不用 Bash + curl。

`dsh plugin --profile web add @wxkingstar/specfusion-dsh`

MIT 开源： https://github.com/wxkingstar/SpecFusion

## X / Twitter English

Shipped a native @DeepSeek Harness plugin for SpecFusion: full-text search over 65,602 API docs from 20 Chinese open platforms. One skill + five read-only DSH tools, zero setup.

`dsh plugin --profile web add @wxkingstar/specfusion-dsh`

https://github.com/wxkingstar/SpecFusion

## Hacker News

**Title**

`Show HN: SpecFusion – 65k Chinese open-platform API docs for AI coding agents`

**Text**

SpecFusion indexes 65,602 official API docs across 20 Chinese open platforms, including WeCom, Feishu, DingTalk, Taobao, Douyin E-commerce, WeChat Pay, Alipay, JD, SHEIN and Volcengine.

It exists because coding agents often know how to write an HTTP request but cannot reliably retrieve the current endpoint, parameters and error codes from 20 inconsistent doc sites. Search supports API names, endpoint paths, error codes and Chinese concepts. Results are returned as Markdown for agents.

I just shipped a native DeepSeek Harness plugin: one runtime skill plus five read-only tools for search, document retrieval, source/category browsing and recent updates. There is also a portable Agent Skill for Claude Code, Codex, Cursor and Gemini CLI.

The hosted service requires no setup; Docker/Kubernetes self-hosting is supported. MIT licensed.

Repo: https://github.com/wxkingstar/SpecFusion

## Reddit

**Title**

`I built a DSH plugin that gives agents searchable access to 65k API docs from Chinese open platforms`

**Body**

I maintain SpecFusion, a full-text index of 65,602 official API docs from 20 Chinese open platforms (WeCom, Feishu, DingTalk, Taobao, Douyin E-commerce, WeChat Pay, Alipay, JD, SHEIN, Volcengine and more).

The new DeepSeek Harness plugin registers one skill and five native read-only tools, so the model can search by API name/path/error code, fetch the relevant document, and continue coding from retrieved context instead of relying on stale memory.

Install: `dsh plugin --profile web add @wxkingstar/specfusion-dsh`

MIT repo: https://github.com/wxkingstar/SpecFusion

