# SpecFusion 推广手册

> 目标读者：需要用「中国企业微信/飞书/钉钉/淘宝/抖音/微信支付/支付宝/京东…」开放平台 API 做开发的 AI 开发者。
> 一句话卖点：**不用切浏览器翻文档站，让 AI 直接搜 65,000+ 篇中国开放平台 API 文档，拿到接口参数继续写代码。**

仓库：https://github.com/wxkingstar/SpecFusion
官网：https://specfusion.kingstar.xin

---

## 一、执行清单（按优先级）

| # | 动作 | 成本 | 说明 |
|---|------|------|------|
| 1 | 给仓库设置 GitHub **Topics** | 1 分钟 | 见 [GitHub 元数据](#六-github-元数据) |
| 2 | 发 **V2EX**（分享创造） | 2 分钟 | 中文开发者流量最集中，[文案](#二-v2ex-分享创造) |
| 3 | 发 **X / Twitter**（中英两条） | 2 分钟 | [文案](#三-x--twitter) |
| 4 | 发 **HN Show HN** | 3 分钟 | 全球曝光，[文案](#四-hacker-news-show-hn) |
| 5 | 发 **掘金** 技术文章 | 30 分钟 | 长尾 SEO，[文案](#五-掘金) |
| 6 | 发 **Reddit**（r/ClaudeAI 等） | 2 分钟 | [文案](#四-hacker-news-show-hn) 可复用 |
| 7 | 提交 **awesome-list** | 每次 5 分钟 | [条目](#七-awesome-list-提交条目) |

> 发布顺序建议：先做 1（元数据），再发 2/3，等有第一波 star 后再发 4/7（很多社区会看仓库热度）。

---

## 二、V2EX（分享创造）

**节点**：`share`（分享创造）
**标题**：

```
[开源] SpecFusion —— 给 AI Agent 用的「中国大厂开放平台 API 文档」搜索，65k+ 篇，Claude Code / Cursor / DSH 直接搜
```

**正文**：

```markdown
做海外 SaaS 或接中国平台（企业微信、飞书、钉钉、淘宝、抖音电商、微信支付、支付宝、京东…）时，最痛苦的不是写代码，是翻文档——每个平台文档站布局都不一样，还经常要登录。

于是我把 20 个中国主流开放平台的 API 文档抓下来，做了全文索引，做成了一个给 AI 用的检索服务 **SpecFusion**：

- 65,000+ 篇官方 API 文档：企业微信 ~2,740、飞书 ~4,260、钉钉 ~2,750、淘宝 ~6,940、京东 ~6,290、火山引擎 ~34,000…
- 中文全文检索（jieba 分词 + FTS5），接口名 / API 路径 / 错误码（60011、40001）/ 功能概念都能搜
- 零配置：云端服务已部署好，装上就能用，不需要自建后端
- 已接入 Claude Code / Cursor / Codex / Gemini CLI / DeepSeek Harness（原生插件）

用起来就一句话：

> 企业微信怎么发应用消息？
> → 直接返回「发送应用消息 POST /cgi-bin/message/send」的接口参数和示例

**安装**（Claude Code 全局）：

    npx skills add wxkingstar/SpecFusion -g -y

DeepSeek Harness：

    dsh plugin --profile web add @wxkingstar/specfusion-dsh

项目完全开源（MIT），自部署支持 Docker。欢迎 star 和提 issue，也欢迎反馈「哪个平台/哪类文档最常用」，我优先补。

- GitHub：https://github.com/wxkingstar/SpecFusion
- 官网（可在线搜）：https://specfusion.kingstar.xin
```

---

## 三、X / Twitter

**中文推**：

```
做了一个给 AI 用的「中国大厂开放平台 API 文档」检索：SpecFusion。

20 个平台、65,000+ 篇文档，全文检索，接口名/路径/错误码都能搜。
Claude Code 一条命令装好：npx skills add wxkingstar/SpecFusion -g -y

不用再切浏览器翻文档站了。
https://github.com/wxkingstar/SpecFusion
```

**英文推**：

```
Shipping SpecFusion: a full-text search index of 65,000+ API docs across 20 Chinese open platforms (WeCom, Feishu, DingTalk, Taobao, Douyin, WeChat Pay, Alipay, JD, SHEIN…).

Built for AI agents — Claude Code / Cursor / DeepSeek Harness, zero setup, cloud-hosted.

https://github.com/wxkingstar/SpecFusion
```

---

## 四、Hacker News（Show HN）

**标题**：

```
Show HN: SpecFusion – full-text search over 65k API docs of China's open platforms
```

**正文**：

```markdown
Integrating with Chinese platforms (WeCom, Feishu, DingTalk, Taobao, Douyin E-commerce, WeChat Mini Program, WeChat Pay, Alipay, JD, SHEIN, Poizon, Volcengine, Alibaba Bailian…) usually means reading 20 different, login-gated doc sites with inconsistent navigation.

SpecFusion crawls those official API docs, indexes them with full-text search (jieba tokenization + SQLite FTS5), and exposes a tiny Markdown API so coding agents can look them up without leaving the terminal.

What's in the box:
- 65,000+ docs across 20 platforms (WeCom ~2,740, Feishu ~4,260, Taobao ~6,940, JD ~6,290, Volcengine ~34,000…)
- Search by API name, endpoint path (/cgi-bin/message/send), error code (60011), or concept
- Zero-setup cloud service, plus Docker/K8s for self-hosting
- Installs as a Claude Code skill (npx skills add wxkingstar/SpecFusion -g -y), a Cursor rule, or a DeepSeek Harness plugin

Repo (MIT): https://github.com/wxkingstar/SpecFusion
Live search: https://specfusion.kingstar.xin

Happy to answer questions, and to hear which platforms/docs people actually need most.
```

---

## 五、掘金（技术文章）

**标题**：

```
我抓了 20 个中国开放平台、65,000+ 篇 API 文档，做了一个给 AI 用的检索服务
```

**大纲**（展开写即可）：

1. **痛点**：接中国平台时，翻文档成本高（登录墙、排版不一、中英文混排）。
2. **方案**：抓取 → 清洗 → jieba 预分词 → FTS5 全文索引 → 只读 Markdown API。
3. **给 AI 的交付形态**：为什么做成「Skill + 原生工具」而不是一个普通网站——AI 需要的是「能被工具调用的结构化检索」，不是网页。
4. **技术细节**：
   - 中文分词（jieba 预分词 + FTS5 unicode61），错误码单独建索引
   - 所有公开 API 返回 `text/markdown`（非 JSON），AI 直接读
   - tsup 打包单文件、SQLite 单文件、Docker/K8s 部署
5. **接入的 Agent 生态**：Claude Code skill、Cursor rule、Codex/Gemini、DeepSeek Harness 插件（含源码要点）。
6. **踩坑**：Playwright 抓 SPA 文档的性能坑、并发控制、证书与部署。
7. **数据与效果**：文档量、平台覆盖、搜索耗时（~100ms 级）。
8. **结尾 CTA**：star、反馈最需要的平台。

---

## 六、GitHub 元数据

仓库页面 → 右上角 ⚙️ → 设置以下字段：

**Description**（约 150 字符）：

```
Full-text search over 65,000+ API docs of 20 Chinese open platforms (WeCom, Feishu, DingTalk, Taobao, Douyin, WeChat, Alipay, JD…) — for AI agents (Claude Code, Cursor, DeepSeek Harness).
```

**Topics**（依次添加）：

```
api-docs, open-api, open-platform, ai-agents, claude-code, cursor,
deepseek-harness, wecom, feishu, dingtalk, taobao, douyin, wechat,
alipay, jd, full-text-search, developer-tools, china
```

**Social preview**：用 `specfusion-promo.mp4` 截一帧做 `opengraph` 图（1200×630），或直接上传官网首屏截图，让分享链接有预览图。

---

## 七、awesome-list 提交条目

提交时用「New issue」或 PR，附以下条目：

```markdown
- [SpecFusion](https://github.com/wxkingstar/SpecFusion) — Full-text search over 65,000+ API docs of 20 Chinese open platforms (WeCom, Feishu, DingTalk, Taobao, Douyin, WeChat Pay, Alipay, JD…), built for AI coding agents (Claude Code skill / Cursor / DeepSeek Harness plugin).
```

候选清单（按相关度）：

| 仓库 | 相关度 | 提交方式 |
|------|--------|----------|
| `hesreallyhim/awesome-claude-code` | 高（Claude Code 生态） | PR 加一行 |
| `anthropics/skills`（或 skills registry） | 高（skill 分发） | 已在 `npx skills` 可搜到，确认收录 |
| `e2b-dev/awesome-ai-agents` | 中 | PR |
| `shubhamsptn/awesome-claude-skills` | 中 | PR |
| `punkpeye/awesome-mcp-servers` | 低（非 MCP，可作「agent tools」旁支） | 谨慎 |

> 提交前先看各仓库的 CONTRIBUTING 格式（有的要按字母排序、有的要一句话描述）。

---

## 附：一句话版本（用于签名/简介/海报）

- 中文：`让 AI 直接搜中国大厂开放平台 API 文档——65k+ 篇，零配置。`
- 英文：`Full-text search of 65k+ China open-platform API docs, built for AI agents.`
