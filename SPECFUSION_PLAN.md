# SpecFusion 项目规划

> 多源 API 文档融合搜索 Skill — 云端检索，零安装，即问即答

## 1. 项目概述

### 1.1 要解决的问题

开发者在对接企业微信、飞书、钉钉等开放平台时，需要频繁查阅 API 文档。痛点包括：

- **文档分散**：每个平台有独立的文档站点，来回切换查找效率低
- **上下文断裂**：从 IDE/终端切到浏览器查文档，打断编码节奏
- **搜索低效**：各平台官方文档搜索质量参差不齐，找到目标接口耗时长
- **AI 知识滞后**：LLM 训练数据有截止日期，无法覆盖最新的 API 变更

### 1.2 解决方案

**SpecFusion** 是一个 Claude Code Skill，将多个开放平台的 API 文档统一采集到云端，提供融合搜索能力。开发者在 Claude Code 中提问时，Skill 自动识别意图、搜索云端文档、获取最新内容并回答。

核心特性：

- **零安装**：一个 SKILL.md 文件（~3 KB），无需 npm 包、无需进程
- **云端检索**：文档存储和搜索在云端完成，用户按需获取
- **多源融合**：统一接入企业微信、飞书、钉钉及任意 OpenAPI 3.x 文档
- **实时更新**：文档每日自动同步，用户无感知
- **即问即答**：Claude 自动识别意图并调用搜索，无需手动操作

### 1.3 名称含义

**Spec**（Specification）+ **Fusion**（融合）= 多源 API 规范文档的融合检索。

### 1.4 与 MCP 版本的关系

本项目前身是 [doc-hub-mcp](https://github.com/anthropics/doc-hub-mcp)，一个将 6,855 篇文档（~55MB）打包到本地的 MCP Server。MCP 方案的问题：

- 安装体积大（npm 包 ~18MB，加 node_modules 超过 100MB）
- Playwright 依赖（~1GB，仅抓取时需要却打包给用户）
- 占用上下文多（MCP 工具描述本身消耗 token）
- 用户需要配置 MCP Server 进程

SpecFusion 保留 MCP 版的文档抓取逻辑（`wecom-scraper.js`、`feishu-scraper.js`），将搜索服务迁移到云端，用户侧仅需一个 ~3KB 的 SKILL.md。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    用户侧（零安装）                        │
│                                                         │
│   ~/.claude/skills/specfusion/SKILL.md   (~3 KB)        │
│                                                         │
│   Skill 教 Claude：                                      │
│   → 何时搜索文档                                         │
│   → 如何调用云端 API（WebFetch）                          │
│   → 如何解读结果并回答用户                                 │
│   → 上下文管理策略（摘要优先、按需全文）                    │
└────────────────────┬────────────────────────────────────┘
                     │ WebFetch (HTTPS)
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    云端服务                               │
│                                                         │
│   Cloudflare Worker（或自托管 Node.js）                   │
│                                                         │
│   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │
│   │  REST API    │  │  搜索引擎     │  │  文档同步     │  │
│   │  返回 MD 格式 │  │  D1 + FTS5   │  │  Cron Worker  │  │
│   │  /search    │  │  jieba 预分词  │  │  适配器模式    │  │
│   │  /doc/:id   │  │              │  │              │  │
│   │  /sources   │  │              │  │              │  │
│   └─────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│   ┌─────────────────────────────────────────────────┐   │
│   │                 存储层（仅 D1）                    │   │
│   │  D1 (SQLite)：元数据 + Markdown 全文 + FTS 索引   │   │
│   │  （单行限制 1MB，单篇 API 文档远不会超过）          │   │
│   └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                     ▲
                     │ 定时同步
┌────────────────────┴────────────────────────────────────┐
│           文档源适配器（复用 doc-hub-mcp 抓取代码）         │
│                                                         │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│   │ 企业微信  │ │  飞书    │ │ OpenAPI  │ │  钉钉    │  │
│   │ Scraper  │ │ API     │ │ 通用解析  │ │(OpenAPI) │  │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────┘
```

**架构决策说明：**

- **存储层只用 D1**：总文档量 ~7,000 篇，SQLite 单表完全够用。砍掉 R2（Markdown 全文直接存 D1 content 列）和 KV（D1 FTS5 查询本身 ~10ms，无需缓存）。后续如文档量超 10 万篇再按需引入。
- **搜索接口返回 Markdown**：WebFetch 内部会对内容做 AI 摘要处理，JSON 结构可能丢失。返回格式化 Markdown 文本让 Claude 直接可读。
- **jieba 预分词**：中文搜索是核心场景，unicode61 按单字切分效果太差，必须从初期就解决。

---

## 3. Skill 设计

### 3.1 文件结构

用户侧仅需复制一个目录：

```
~/.claude/skills/specfusion/
├── SKILL.md             # 主指令文件（~3 KB）
└── sources.md           # 支持的文档源参考（按需加载）
```

后续 Plugin 生态成熟后可改为 Plugin 分发：

```
specfusion-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── specfusion/
│       ├── SKILL.md
│       └── sources.md
└── README.md
```

### 3.2 plugin.json（后续 Plugin 分发时使用）

```json
{
  "name": "specfusion",
  "version": "1.0.0",
  "description": "多源 API 文档融合搜索 — 企业微信、飞书、钉钉等开放平台文档即时检索",
  "author": {
    "name": "wangxin"
  },
  "repository": "https://github.com/anthropics/specfusion",
  "license": "MIT",
  "keywords": ["api-docs", "wecom", "feishu", "openapi", "search"],
  "skills": "./skills/"
}
```

### 3.3 SKILL.md

```markdown
---
name: specfusion
description: |
  搜索企业微信、飞书、钉钉等开放平台的 API 文档。当用户询问以下内容时自动触发：
  - 企业微信/飞书/钉钉等平台的 API 用法、参数、接口说明
  - 如何调用某个开放平台接口（发消息、获取用户、创建审批等）
  - 开放平台的 webhook、回调、事件订阅配置
  - OAuth、授权、access_token 获取流程
  - 任何涉及第三方平台 OpenAPI 规范的开发问题
  触发关键词：企业微信、飞书、钉钉、开放平台、API文档、接口文档、
  wecom、feishu、dingtalk、lark、openapi、webhook、access_token
user-invocable: true
argument-hint: "企业微信发送消息 / feishu 审批 / 搜索关键词"
allowed-tools: WebFetch, Bash, Read
---

# SpecFusion — 多源 API 文档搜索

你可以通过云端 API 搜索企业微信、飞书、钉钉等平台的开发文档。

## API 端点

Base URL: `https://specfusion.your-domain.com/api`

## 搜索文档

使用 WebFetch 调用搜索接口：

```
GET {BASE_URL}/search?q={关键词}&source={来源}&limit={数量}
```

参数说明：
- `q`（必填）：搜索关键词，支持多种搜索方式：
  - 接口名搜索：`发送应用消息`、`获取部门列表`
  - API 路径搜索：`/cgi-bin/message/send`、`/open-apis/contact/v3/users`
  - 错误码搜索：`60011`、`40001`、`errcode 40001`
  - 功能概念搜索：`客户联系`、`会话存档`、`消息卡片`
- `source`（可选）：文档来源过滤，可选值为 wecom / feishu / dingtalk，不填搜索全部
- `mode`（可选，仅企业微信）：开发模式过滤，可选值为 internal（自建应用）/ third_party（第三方应用）/ service_provider（服务商代开发）
- `limit`（可选）：返回数量，默认 5，最大 20

返回格式为 Markdown 纯文本（非 JSON），可直接阅读，示例：

```
## 搜索结果：发送消息（来源：企业微信，共 42 条，耗时 12ms）

### 1. 发送应用消息 [score: 15.2]
- 来源：企业微信 | 模式：自建应用 | 路径：服务端API/消息推送/发送应用消息
- 接口：`POST /cgi-bin/message/send`
- 摘要：调用该接口可以向指定的用户发送应用消息，包括文本、图片、视频...
- 文档ID：wecom_90236
- 原文：https://developer.work.weixin.qq.com/document/path/90236
- 更新：2025-12-15

### 2. 发送消息到群聊 [score: 11.8]
...
```

## 获取文档内容

找到目标文档后，获取文档内容：

```
GET {BASE_URL}/doc/{doc_id}                  # 返回全文 Markdown
GET {BASE_URL}/doc/{doc_id}?summary=true     # 返回结构化摘要（~1KB）
```

两种模式都直接返回 Markdown 纯文本（非 JSON），可直接阅读。

摘要模式只返回：接口名称和描述、HTTP 方法和路径、请求参数表格、关键示例（截断到 500 字符）。适合快速预览是否为目标文档。

## 查看可用文档源

```
GET {BASE_URL}/sources
```

返回所有已接入的文档源及其文档数量（Markdown 格式）。

## 使用流程

1. **提取关键词**：从用户问题中提取最具体的 API 名称或功能描述
2. **搜索文档**：调用 `/search` 接口，如果用户指定了平台则添加 `source` 参数
3. **预览文档**：对搜索结果中最相关的文档，先用 `/doc/{doc_id}?summary=true` 摘要模式预览
4. **获取全文**：确认是目标文档后，再调用 `/doc/{doc_id}` 获取完整内容
5. **回答用户**：基于文档内容回答，引用文档标题和来源平台

## 上下文管理

- 搜索结果超过 3 条时，先展示列表让用户选择，而非逐个获取全文
- 获取文档时优先使用 `summary=true` 摘要模式预览
- 仅当用户需要具体参数、代码示例或完整细节时才获取全文
- 单次对话中建议不超过 3 篇全文，超过时提示用户上下文可能不足（软限制，非硬性规定）
- 如果用户问题涉及多个接口，分多次搜索，每次聚焦一个
- 如果 WebFetch 返回的全文看起来被截断，用 `Bash(curl)` 重试获取原始完整内容

## 注意事项

- 优先搜索具体 API 名称，泛搜效果差（"发送应用消息" 优于 "消息"）
- 如果用户提供了完整的 API 路径（如 `/cgi-bin/message/send` 或 `/open-apis/contact/v3/users`），直接按路径搜索，命中率更高
- 首次搜索不理想时，尝试同义词或换个角度的关键词
- 回答时注明文档来源（如"根据企业微信文档《发送应用消息》..."）
- 企业微信文档区分开发模式：搜到多篇同名文档时，确认用户是自建应用、第三方应用还是服务商代开发，加 `mode` 参数过滤
- 文档内容可能包含代码示例，保留原始格式展示给用户
- 跨平台对比：当用户问"企业微信和飞书的消息发送有什么区别"等对比问题时，分别搜索两个平台，做对比展示

## 降级方案

如果云端 API 不可用（WebFetch 返回错误或超时）：

1. 首选：用 WebFetch 直接访问对应平台的官方文档搜索页面
2. 备选：用 `Bash(curl)` 调用云端 API 获取原始响应
3. 兜底：引导用户直接访问官方文档站点
   - 企业微信：https://developer.work.weixin.qq.com/document/
   - 飞书：https://open.feishu.cn/document/
   - 钉钉：https://open.dingtalk.com/document/

## 定位说明

本工具搜索的是各开放平台的 **API 开发文档**，不是平台内部的用户文档。
如需操作飞书（发消息、创建文档等），请使用飞书官方 MCP Server。
如需操作企业微信（发消息、管理通讯录等），请使用企业微信 API 直接调用。

## 支持的文档源

当前已接入的平台详见 [sources.md](sources.md)。
```

### 3.4 sources.md（辅助参考文件）

```markdown
# 已接入文档源

| 平台 | source 参数 | 文档数量 | 覆盖范围 | 同步频率 |
|------|------------|---------|---------|---------|
| 企业微信 | wecom | ~2,760 | 服务端 API、客户端 API、应用开发 | 每日 |
| 飞书 | feishu | ~4,095 | 服务端 API、事件订阅、小程序 | 每日 |
| 钉钉 | dingtalk | 待接入（OpenAPI 适配器） | — | — |
| 微信支付 | wxpay | 待接入 | — | — |

## 平台特色内容

### 企业微信 (wecom)
- 通讯录管理（部门、成员、标签）
- 消息推送（应用消息、群机器人）
- 客户联系（外部联系人、客户群）
- 身份验证（OAuth、JS-SDK）
- 审批流程、打卡、日程

### 飞书 (feishu)
- 消息与群组（发送消息、群管理）
- 云文档（文档、表格、多维表格）
- 审批（创建、查询审批实例）
- 日历与会议
- 机器人（自定义机器人、消息卡片）

## 即将接入

- 钉钉开放平台（通过 OpenAPI 通用适配器）
- 微信支付商户 API
- Stripe API
- Shopify Admin API
- 通用 OpenAPI 3.x 文档导入
```

---

## 4. 云端 API 设计

### 4.1 技术选型

提供两套可选方案，根据实际部署条件选择：

| 维度 | 方案 A：Cloudflare 全家桶 | 方案 B：自托管 Node.js |
|------|------------------------|---------------------|
| 运行时 | Cloudflare Worker | Node.js + Fastify |
| 数据库 | D1 (SQLite) | SQLite + better-sqlite3 |
| 全文搜索 | D1 FTS5 + jieba 预分词 | SQLite FTS5 + jieba 预分词 |
| 部署 | `wrangler deploy` | Docker / K8S |
| 成本 | 免费额度（10万请求/天） | 服务器成本 |
| 全球延迟 | 边缘节点 ~20ms | 单区域 |

**推荐方案 A**，除非有合规/内网部署要求。

**简化存储决策**：初期只使用 D1 单数据库，Markdown 全文直接存 D1 的 `content` 列（单行限制 1MB，单篇 API 文档远不会超过）。不引入 R2（对象存储）和 KV（缓存），减少架构复杂度。后续如文档量超 10 万篇或搜索延迟不满足需求，再按需引入。

### 4.2 API 路由设计

```
# === 公开接口（Skill 调用）===
# 关键决策：所有公开接口返回 text/markdown 格式
# 原因：WebFetch 内部会对内容做 AI 摘要，JSON 结构可能丢失；
#       Markdown 文本让 Claude 直接可读，无需解析

GET  /api/search
     ?q=发送消息          # 必填，搜索关键词（支持接口名/API路径/错误码）
     &source=wecom        # 可选，文档源过滤
     &mode=internal       # 可选，开发模式过滤（仅企业微信：internal/third_party/service_provider）
     &limit=5             # 可选，返回数量 1-20，默认 5
     → 200 text/markdown（格式化搜索结果）

GET  /api/doc/:docId
     ?summary=true        # 可选，返回结构化摘要（~1KB）而非全文
     → 200 text/markdown（文档全文或摘要）
     → 404 text/markdown（"## 文档未找到\n\n文档 ID `{docId}` 不存在。"）

GET  /api/sources
     → 200 text/markdown（已接入文档源列表）

# === 管理接口（抓取脚本调用，需认证）===

POST /api/admin/upsert
     Authorization: Bearer <ADMIN_TOKEN>
     Body: { source, path, title, content, metadata }
     → 200 { doc_id, action: "created" | "updated" }

POST /api/admin/bulk-upsert
     Authorization: Bearer <ADMIN_TOKEN>
     Body: { source, documents: [{ path, title, content, metadata }] }
     → 200 { created: N, updated: N, unchanged: N }

DELETE /api/admin/doc/:docId
       Authorization: Bearer <ADMIN_TOKEN>
       → 200 { deleted: true }

POST /api/admin/reindex
     Authorization: Bearer <ADMIN_TOKEN>
     → 200 { reindexed: N }

# === 健康检查 ===

GET  /api/health
     → 200 { status: "ok", sources: [...], total_docs: N }
```

### 4.3 响应格式

#### 搜索结果（text/markdown）

```markdown
## 搜索结果：发送消息（来源：企业微信，共 42 条，耗时 12ms）

### 1. 发送应用消息 [score: 15.2]
- 来源：企业微信 | 模式：自建应用 | 路径：服务端API/消息推送/发送应用消息
- 接口：`POST /cgi-bin/message/send`
- 摘要：调用该接口可以向指定的用户发送应用消息，包括文本、图片、视频...
- 文档ID：wecom_90236
- 原文：https://developer.work.weixin.qq.com/document/path/90236
- 更新：2025-12-15

### 2. 发送消息到群聊 [score: 11.8]
- 来源：企业微信 | 模式：自建应用 | 路径：服务端API/消息推送/发送消息到群聊
- 接口：`POST /cgi-bin/appchat/send`
- 摘要：通过群聊机器人发送消息到指定群聊...
- 文档ID：wecom_90248
- 原文：https://developer.work.weixin.qq.com/document/path/90248
- 更新：2025-12-10
```

#### 文档全文（text/markdown）

直接返回 Markdown 纯文本，Content-Type: `text/markdown; charset=utf-8`。

文档头部保留元信息（Markdown 注释，不影响渲染）：

```markdown
<!-- source: wecom | path: 服务端API/消息推送/发送应用消息 -->
<!-- source_url: https://developer.work.weixin.qq.com/document/path/90236 -->
<!-- last_updated: 2025-12-15 -->

# 发送应用消息

应用支持推送文本、图片、视频、文件、图文等类型...
```

#### 文档摘要模式（text/markdown，?summary=true）

```markdown
<!-- source: wecom | doc_id: wecom_90236 -->

# 发送应用消息

> 调用该接口可以向指定的用户发送应用消息，支持文本、图片、视频、文件、图文等类型。

## 接口信息

- **方法**：POST
- **路径**：`/cgi-bin/message/send`
- **原文**：https://developer.work.weixin.qq.com/document/path/90236

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| touser | string | 否 | 接收消息的用户ID列表 |
| toparty | string | 否 | 接收消息的部门ID列表 |
| msgtype | string | 是 | 消息类型 |
| agentid | integer | 是 | 企业应用的id |

*（完整参数和代码示例请获取全文：`/doc/wecom_90236`）*
```

#### 文档源列表（text/markdown）

```markdown
## 已接入文档源

| 平台 | source 参数 | 文档数量 | 最后同步 |
|------|------------|---------|---------|
| 企业微信 | wecom | 2,760 | 2025-12-15 |
| 飞书 | feishu | 4,095 | 2025-12-15 |
```

### 4.4 搜索评分算法

```
score = (api_path_exact_match × 50)               # API 路径精确匹配，最高优先
      + (error_code_exact_match × 50)              # 错误码精确匹配，最高优先
      + (title_exact_match × 20)
      + (title_token_match × 5 × matched_ratio)
      + (content_fts_rank × 1)
      + (doc_type_boost)                           # API 参考文档 +3，开发指南 +0
      + (recency_bonus)                            # 最近更新的文档 +1~3 分
      - (path_depth_penalty × 0.5)                 # 路径越深越细节，泛搜时降权
```

- 使用 SQLite FTS5 的 `bm25()` 函数作为 content_fts_rank 基础分，叠加标题匹配加权
- `api_path_exact_match`：如果查询匹配 documents 表的 `api_path` 字段（如 `/cgi-bin/message/send`），直接置顶
- `error_code_exact_match`：如果查询是纯数字或匹配 `errcode \d+` 模式，在错误码索引中精确匹配
- `doc_type_boost`：API 参考类文档 +3 分，开发指南/教程类 +0 分。搜 API 名称时优先返回 API 参考而非指南中顺带提到的段落
- `path_depth_penalty`：路径层级数，如 `服务端API/消息推送/发送应用消息` 深度为 3，泛搜时深层文档降权
- `recency_bonus`：最近 30 天更新 +3 分，90 天内 +1 分

### 4.5 摘要生成算法

`/doc/:id?summary=true` 的摘要从全文 Markdown 中提取，不需要额外存储：

```
1. 提取标题（第一个 # 标题）
2. 提取描述（标题后的第一段非"权限说明"文本，截断到 200 字符）
   注意：企业微信文档第一段可能是权限说明而非接口描述，需跳过
3. 提取接口信息（从内容中匹配 HTTP 方法 + 路径模式）
   - 企业微信格式：/cgi-bin/xxx
   - 飞书格式：/open-apis/模块/版本/资源
   - OpenAPI 格式：METHOD /path
4. 提取参数表格（第一个 Markdown 表格，最多 10 行）
5. 拼接为结构化 Markdown，末尾提示获取全文
```

**注意**：摘要提取逻辑需要做源级别的适配，不同平台文档结构差异较大。

---

## 5. 数据库设计

### 5.1 Schema (SQLite / D1)

```sql
-- 文档源
CREATE TABLE sources (
    id          TEXT PRIMARY KEY,        -- "wecom", "feishu", "dingtalk"
    name        TEXT NOT NULL,           -- "企业微信", "飞书"
    base_url    TEXT,                    -- 官方文档 base URL
    doc_count   INTEGER DEFAULT 0,
    last_synced TEXT,                    -- ISO 8601 时间戳
    config      TEXT                     -- JSON，源特定配置
);

-- 文档（Markdown 全文直接存 content 列，D1 单行限制 1MB，足够）
CREATE TABLE documents (
    id           TEXT PRIMARY KEY,       -- "{source}_{doc_id}" 如 "wecom_90236"（使用平台稳定 ID，非内容 hash）
    source_id    TEXT NOT NULL,
    path         TEXT NOT NULL,          -- 文档路径层级
    path_depth   INTEGER NOT NULL DEFAULT 1, -- 路径层级数，用于搜索降权
    title        TEXT NOT NULL,
    api_path     TEXT,                   -- HTTP 接口路径（如 /cgi-bin/message/send），用于精确匹配搜索
    dev_mode     TEXT,                   -- 开发模式（仅企业微信）：internal / third_party / service_provider
    doc_type     TEXT DEFAULT 'api_reference', -- 文档类型：api_reference / guide / error_code / event / card_template / changelog
    content      TEXT NOT NULL,          -- Markdown 全文
    content_hash TEXT NOT NULL,          -- SHA-256，用于增量更新判断
    prev_content_hash TEXT,              -- 上一版本的 hash，用于追踪变更
    source_url   TEXT,                   -- 官方原文链接
    metadata     TEXT,                   -- JSON，额外元信息（含 event_name、scope 等可搜索字段）
    tokenized_title   TEXT,              -- jieba 预分词后的标题（空格分隔 token）
    tokenized_content TEXT,              -- jieba 预分词后的内容（空格分隔 token）
    last_updated TEXT,                   -- 文档内容最后更新时间
    synced_at    TEXT NOT NULL,          -- 入库/同步时间
    UNIQUE(source_id, path)
);

CREATE INDEX idx_documents_source ON documents(source_id);
CREATE INDEX idx_documents_updated ON documents(last_updated);
CREATE INDEX idx_documents_api_path ON documents(api_path);
CREATE INDEX idx_documents_dev_mode ON documents(source_id, dev_mode);
CREATE INDEX idx_documents_doc_type ON documents(doc_type);

-- 错误码映射表（支持错误码精确搜索）
CREATE TABLE error_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL,           -- "wecom", "feishu"
    code        TEXT NOT NULL,           -- 错误码值（如 "60011"、"40001"）
    message     TEXT,                    -- 错误信息（如 "invalid corpid"）
    description TEXT,                    -- 错误说明
    doc_id      TEXT,                    -- 关联的文档 ID（指向错误码文档页）
    UNIQUE(source_id, code)
);

CREATE INDEX idx_error_codes_code ON error_codes(code);

-- FTS5 全文检索（使用 jieba 预分词后的内容）
-- 设计：应用层在写入 documents 表时，对 title/content 做 jieba 分词，
-- 将分词结果（空格分隔 token）存入 tokenized_title / tokenized_content 列。
-- FTS5 使用 unicode61 tokenizer 按空格切分这些预分词文本，即可实现中文精确匹配。
CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,
    content,
    content='documents',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, content)
    VALUES (new.rowid, new.tokenized_title, new.tokenized_content);
END;

CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.tokenized_title, old.tokenized_content);
END;

CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.tokenized_title, old.tokenized_content);
    INSERT INTO documents_fts(rowid, title, content)
    VALUES (new.rowid, new.tokenized_title, new.tokenized_content);
END;

-- 同步日志
CREATE TABLE sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,           -- "running", "success", "failed"
    created     INTEGER DEFAULT 0,
    updated     INTEGER DEFAULT 0,
    unchanged   INTEGER DEFAULT 0,
    error       TEXT
);

-- 搜索日志（用于后续分析热门查询、优化搜索质量）
CREATE TABLE search_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    query       TEXT NOT NULL,           -- 原始搜索词
    source      TEXT,                    -- 来源过滤（可为空）
    result_count INTEGER NOT NULL,       -- 返回结果数
    top_score   REAL,                    -- 最高分
    took_ms     INTEGER,                -- 耗时
    created_at  TEXT NOT NULL            -- ISO 8601 时间戳
);

CREATE INDEX idx_search_log_created ON search_log(created_at);
```

### 5.2 中文搜索方案（初期必做）

**为什么不能等后续优化：** SQLite FTS5 的 `unicode61` tokenizer 对中文按单字切分，搜索"发送消息"会被拆成 `发 | 送 | 消 | 息`，导致大量不相关文档被召回。这直接影响搜索可用性。

**采用方案：写入时 jieba 预分词**

```
写入流程：
  原文 → jieba.cut(text) → 空格分隔 token → 存入 tokenized_title / tokenized_content 列

  示例：
  原文："调用该接口可以向指定的用户发送应用消息"
  分词后："调用 该 接口 可以 向 指定 的 用户 发送 应用 消息"

搜索流程：
  查询 → jieba.cut(query) → 空格分隔 → FTS5 MATCH

  示例：
  查询："发送消息"
  分词后："发送 消息"
  FTS5 MATCH："发送 消息" → 精确匹配到包含这两个词的文档
```

**实现位置：**
- 抓取脚本（Node.js）：用 `nodejieba` 对写入内容分词
- 云端 Worker：用 `@aspect/jieba-wasm`（~1.5MB）对搜索查询分词
- **关键：写入和查询必须使用同一套词典**，否则分词结果不一致会导致精确匹配失败

**自定义用户词典（Phase 1 必做）：**

jieba 默认词典不包含平台专有术语，会导致分词错误。初期准备 ~100 个高频专有术语即可：

```
# 企业微信专有术语
自建应用 5
代开发 5
客户联系 5
会话存档 5
客户群 5
外部联系人 5
access_token 5
corpid 5
agentid 5
suite_access_token 5
JS-SDK 5
第三方应用 5

# 飞书专有术语
多维表格 5
消息卡片 5
自定义机器人 5
tenant_access_token 5
user_access_token 5
app_access_token 5
飞书文档 5
飞书审批 5
云文档 5

# 通用 API 术语
access_token 5
webhook 5
openapi 5
```

词典文件路径：`scrapers/config/userdict.txt`，scraper 和 Worker 共享同一份。

**Phase 2+ 优化路径：**
- 补充同义词表（如 "token" ↔ "令牌"，"webhook" ↔ "回调"，"第三方应用" ↔ "三方应用" ↔ "ISV应用"）
- 基于搜索日志中的"无结果查询"持续补充词典

---

## 6. 文档源适配器

### 6.1 适配器接口

```typescript
interface DocSource {
    /** 唯一标识 */
    id: string;
    /** 显示名称 */
    name: string;
    /** 获取完整文档目录 */
    fetchCatalog(): Promise<DocEntry[]>;
    /** 获取单篇文档内容 */
    fetchContent(entry: DocEntry): Promise<DocContent>;
    /** 检测自某时间以来的变更（增量同步） */
    detectUpdates(since: Date): Promise<DocEntry[]>;
}

interface DocEntry {
    path: string;           // 文档路径
    title: string;          // 文档标题
    apiPath?: string;       // HTTP 接口路径（如 /cgi-bin/message/send）
    devMode?: string;       // 开发模式（仅企业微信）：internal / third_party / service_provider
    docType?: string;       // 文档类型：api_reference / guide / error_code / event / card_template / changelog
    sourceUrl?: string;     // 官方原文链接
    lastUpdated?: string;   // 最后更新时间
}

interface DocContent {
    markdown: string;       // Markdown 内容
    apiPath?: string;       // 从内容中提取的 HTTP 接口路径
    errorCodes?: Array<{    // 从内容中提取的错误码列表
        code: string;
        message?: string;
        description?: string;
    }>;
    metadata?: Record<string, unknown>;
}
```

### 6.2 适配器列表与优先级

| 适配器 | 数据获取方式 | 特殊处理 | 优先级 | 备注 |
|--------|------------|---------|-------|------|
| `WecomSource` | Cookie 认证 + HTML 抓取 | 需 Cookie，有 rate limit 和人机验证 | **P0** | 复用 doc-hub-mcp 的 `wecom-scraper.js` |
| `FeishuSource` | REST API（无需登录） | 支持并发，有分页 | **P0** | 复用 doc-hub-mcp 的 `feishu-scraper.js` |
| `OpenAPISource` | 解析 OpenAPI 3.x YAML/JSON | 通用适配器，一个 spec URL 接入一个平台 | **P0** | 最有杠杆率的扩展机制 |
| `DingtalkSource` | 通过 OpenAPI 适配器接入 | 如有 OpenAPI spec 直接复用 | **P1** | 不单独写 scraper |
| `WxpaySource` | Web Scraper | 类似企业微信 | **P2** | |

### 6.3 复用 doc-hub-mcp 抓取代码

现有 MCP 版本的两个 scraper 是核心资产，直接迁移复用：

| 文件 | 行数 | 核心能力 | 迁移改造点 |
|------|------|---------|-----------|
| `wecom-scraper.js` | 703 | Cookie 认证、CAPTCHA 浏览器登录、HTML→MD 管线、1200ms 限速 | 输出从写文件改为调用 `/api/admin/bulk-upsert` |
| `feishu-scraper.js` | 678 | 飞书专有标签处理（`<md-text>`、`<md-alert>` 等）、6 路并发、时间戳增量判断 | 同上 |
| `retry-failed.js` | 177 | 失败文档恢复重试 | 集成到同步调度器的失败重试逻辑 |

**迁移步骤：**

1. 将现有 JS 文件复制到 `scrapers/src/sources/` 目录
2. 用 `DocSource` 接口包裹（`fetchCatalog` / `fetchContent` / `detectUpdates`）
3. 输出目标从 `fs.writeFile()` 改为收集到数组后批量调用 admin API
4. 增量同步逻辑对接 `content_hash` 比较（替代现有的日期比较）
5. 保留所有 HTML 解析、Markdown 转换、Cookie 管理逻辑不变

**不需要重写的部分：**
- HTML → Markdown 转换管线（`preprocessHtml` / `postProcessMarkdown` / `cleanupMarkdown`）
- 飞书自定义标签处理器（`<md-text>`、`<md-enum>`、`<md-alert>` 等）
- Cookie 持久化和浏览器登录流程
- 并发控制和限速逻辑（`p-queue`）
- Front matter 生成（但可简化，因为元信息存入数据库而非文件头）

**WecomSource 风险与应对：**

| 风险 | 表现 | 应对策略 |
|------|------|---------|
| Cookie 过期 | 请求返回 302 或登录页 HTML | 每次同步前执行 Cookie 健康检查（请求一篇已知文档，验证返回内容是否含预期 HTML 结构）；失败时告警通知 |
| CAPTCHA 重触发 | 连续请求 200-300 篇后触发人机验证 | 采用自适应限速：前 100 篇 1200ms，100-200 篇 1800ms，200+ 篇 2500ms；检测到 CAPTCHA 页面时暂停并告警 |
| 同步质量异常 | 文档数量突降（网站改版/抓取逻辑失效） | 同步质量门控：如果本次抓到的文档数比上次少 10% 以上，暂停写入并告警，需人工确认后继续 |
| dev_mode 误分 | 同名文档分属不同开发模式，但未正确标记 | 从文档路径和内容中提取开发模式标记（企业微信文档 URL 中含 `/is_third/1` 等），写入 `dev_mode` 字段 |

### 6.4 OpenAPI 通用适配器

这是最重要的扩展机制。用户只需提供一个 OpenAPI spec URL，即可自动生成文档：

```typescript
class OpenAPISource implements DocSource {
    constructor(
        private specUrl: string,    // OpenAPI spec 地址
        private sourceId: string,   // 如 "stripe"
        private sourceName: string  // 如 "Stripe API"
    ) {}

    async fetchCatalog(): Promise<DocEntry[]> {
        const spec = await fetchAndParse(this.specUrl);
        // 每个 path + method 组合生成一篇文档
        return Object.entries(spec.paths).flatMap(([path, methods]) =>
            Object.entries(methods).map(([method, operation]) => ({
                path: `${operation.tags?.[0] || 'general'}/${method.toUpperCase()} ${path}`,
                title: operation.summary || `${method.toUpperCase()} ${path}`,
                sourceUrl: operation.externalDocs?.url
            }))
        );
    }

    async fetchContent(entry: DocEntry): Promise<DocContent> {
        // 将 OpenAPI operation 渲染为结构化 Markdown：
        // - 接口描述
        // - 请求参数表格
        // - 请求体 Schema
        // - 响应示例
        // - 错误码
        return { markdown: renderOperationToMarkdown(operation) };
    }
}
```

**OpenAPI 解析增强：**

| 特性 | 说明 |
|------|------|
| `$ref` 递归 | 递归解析 `$ref` 引用，最大深度 5 层，超出后展示 `[见定义: SchemaName]` |
| `allOf`/`oneOf`/`anyOf` | 合并渲染（allOf 合并所有属性，oneOf/anyOf 展示为"方式一/方式二"分块） |
| Swagger 2.0 兼容 | 检测到 `swagger: "2.0"` 时自动转换为 OpenAPI 3.0 格式再解析（用 `swagger2openapi` 库） |
| 多文件 Spec | 支持 `$ref` 指向外部文件的情况（如 `./models/User.yaml`），相对路径基于 spec URL 解析 |
| 参数位置区分 | 参数表格中明确标注位置：`path` / `query` / `header` / `body`，生成独立分组 |
| 错误码提取 | 从 responses 中提取非 2xx 状态码及描述，写入 `error_codes` 表 |

生成的 Markdown 文档格式示例：

```markdown
# POST /v1/charges - 创建收费

创建一个新的收费对象。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| amount | integer | 是 | 收费金额（单位：分） |
| currency | string | 是 | 三位货币代码 |
| source | string | 否 | 支付来源 token |

## 请求示例

```json
{
  "amount": 2000,
  "currency": "usd",
  "source": "tok_visa"
}
\```

## 响应

```json
{
  "id": "ch_1abc",
  "object": "charge",
  "amount": 2000,
  "status": "succeeded"
}
\```
```

### 6.5 FeishuSource 特殊处理

飞书文档通过公开 REST API 获取，无需登录，但有以下特殊处理需求：

| 处理项 | 说明 |
|--------|------|
| 响应结构校验 | 飞书 API 返回 `{ code: 0, data: {...} }` 格式，非 code=0 时需记录错误并跳过，不写入 `content=undefined` 的脏数据 |
| `<md-*>` 标签兜底 | 飞书文档含自定义标签（`<md-text>`、`<md-enum>`、`<md-alert>` 等），已知标签有专用处理器；**未知标签**统一执行 strip 清理（保留内文本，移除标签本身），避免 Markdown 中出现原始 HTML 标签 |
| 事件名索引 | 事件订阅文档的事件名（如 `contact.user.created_v3`）写入 metadata 的 `event_name` 字段，搜索时支持精确匹配 |
| 文档类型分类 | 根据路径自动标记 `doc_type`：`/event/` 路径 → `event`，`/card/` → `card_template`，`/server-api/` → `api_reference`，其他 → `guide` |
| 多语言处理 | 飞书文档默认获取中文版本（`?locale=zh-CN`），暂不处理多语言，后续可扩展 |
| 权限 scope 分词 | 文档中的权限 scope（如 `contact:user.base:readonly`）作为整体加入 jieba 用户词典，避免被切碎 |

---

## 7. 项目目录结构

```
specfusion/
│
├── skill/                              # Skill 文件（分发给用户）
│   ├── SKILL.md                        # 主指令（~3 KB）
│   └── sources.md                      # 文档源参考
│
├── plugin/                             # Claude Code Plugin（后续分发）
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── skills/
│   │   └── specfusion/
│   │       ├── SKILL.md
│   │       └── sources.md
│   └── README.md
│
├── api/                                # 云端 API 服务
│   ├── src/
│   │   ├── index.ts                    # 入口（Worker 或 Fastify）
│   │   ├── routes/
│   │   │   ├── search.ts              # GET /api/search → text/markdown
│   │   │   ├── doc.ts                 # GET /api/doc/:id → text/markdown
│   │   │   ├── sources.ts            # GET /api/sources → text/markdown
│   │   │   ├── admin.ts              # POST /api/admin/* → JSON
│   │   │   └── health.ts             # GET /api/health → JSON
│   │   ├── services/
│   │   │   ├── search-engine.ts       # FTS5 查询 + 评分
│   │   │   ├── doc-store.ts           # 文档读写
│   │   │   ├── summarizer.ts          # 文档摘要生成
│   │   │   └── tokenizer.ts           # jieba 分词封装
│   │   ├── middleware/
│   │   │   ├── auth.ts                # Admin Token + IP 白名单
│   │   │   ├── rate-limit.ts          # 请求限流
│   │   │   └── cors.ts               # CORS 配置
│   │   └── types.ts                   # 共享类型定义
│   ├── db/
│   │   └── schema.sql                 # 数据库建表脚本
│   ├── wrangler.toml                  # Cloudflare 配置（方案 A）
│   ├── Dockerfile                     # Docker 配置（方案 B）
│   ├── package.json
│   └── tsconfig.json
│
├── scrapers/                           # 文档抓取/同步脚本
│   ├── src/
│   │   ├── types.ts                   # DocSource 接口定义
│   │   ├── sources/
│   │   │   ├── wecom.ts               # 企业微信适配器（迁移自 doc-hub-mcp）
│   │   │   ├── feishu.ts              # 飞书适配器（迁移自 doc-hub-mcp）
│   │   │   └── openapi.ts            # 通用 OpenAPI 适配器
│   │   ├── utils/
│   │   │   ├── html-to-md.ts          # HTML→Markdown 工具（提取自现有 scraper）
│   │   │   ├── tokenizer.ts           # jieba 分词（写入时用）
│   │   │   └── cookies.ts             # Cookie 管理（复用现有逻辑）
│   │   ├── sync.ts                    # 同步调度器
│   │   └── cli.ts                     # CLI 入口
│   ├── config/
│   │   └── sources.yaml               # 文档源配置
│   ├── package.json
│   └── tsconfig.json
│
├── package.json                        # Monorepo 根配置
├── turbo.json                          # Turborepo 配置（可选）
├── CLAUDE.md
├── README.md
└── LICENSE
```

---

## 8. 文档同步流程

### 8.1 同步配置

```yaml
# scrapers/config/sources.yaml
sources:
  - id: wecom
    name: 企业微信
    adapter: wecom
    schedule: "0 3 * * 0"          # 每周日凌晨 3 点全量同步
    incremental_schedule: "0 3 * * 1-6"  # 周一到周六增量同步
    options:
      cookie_file: .wecom_cookies.json
      cookie_health_check: true     # 同步前校验 Cookie 有效性
      rate_limit:                   # 自适应限速（非固定值）
        initial: 1200               # 前 100 篇：1200ms
        medium: 1800                # 100-200 篇：1800ms
        conservative: 2500          # 200+ 篇：2500ms
      quality_gate:
        min_doc_ratio: 0.9          # 文档数量不得低于上次的 90%

  - id: feishu
    name: 飞书
    adapter: feishu
    schedule: "0 4 * * *"          # 每天凌晨 4 点
    options:
      concurrency: 6               # 飞书公开 API，可并发
      response_validation: true     # 校验返回 code=0
      locale: zh-CN                # 默认获取中文版本

  - id: stripe
    name: Stripe API
    adapter: openapi
    schedule: "0 5 * * 1"          # 每周一
    options:
      spec_url: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
      ref_depth_limit: 5           # $ref 递归解析最大深度
```

### 8.2 同步流程

```
1. 读取 sources.yaml 配置
2. 对每个源执行：
   a. 【前置检查】如为 WecomSource，执行 Cookie 健康检查：
      - 请求一篇已知文档 URL，验证返回内容含预期 HTML 结构
      - 检查失败 → 告警通知，跳过本次同步
   b. adapter.fetchCatalog() → 获取文档列表
   c. 【质量门控】对比上次同步的文档总数：
      - 如果本次抓到的文档数 < 上次的 90% → 暂停写入，告警通知
      - 需人工确认"是真删除还是抓取异常"后再继续
   d. 对比云端已有文档的 content_hash
   e. 仅对变更/新增文档执行 adapter.fetchContent()
   f. 对文档内容做 jieba 分词，生成 tokenized_title / tokenized_content
   g. 从文档内容中提取 api_path、error_codes 等结构化字段
   h. 调用 POST /api/admin/bulk-upsert 批量写入（包含分词结果和结构化字段）
   i. 删除云端存在但源已移除的文档（需通过质量门控后才执行）
   j. 写入 sync_log 记录
3. 输出同步报告（含新增/更新/删除/跳过数量，以及质量门控结果）
```

### 8.3 运行方式

```bash
# 手动全量同步
node scrapers/dist/cli.js sync --source wecom

# 手动增量同步
node scrapers/dist/cli.js sync --source feishu --incremental

# 添加新 OpenAPI 源
node scrapers/dist/cli.js add-source \
  --id stripe \
  --name "Stripe API" \
  --adapter openapi \
  --spec-url https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json

# 定时任务（Cloudflare Cron Trigger 或 crontab）
```

---

## 9. 安全与认证

### 9.1 公开接口（无认证）

搜索和文档获取接口不设认证：
- 文档内容本身是各平台公开的开发者文档
- 降低 Skill 调用复杂度（无需配 token）
- 通过 rate limit 防滥用

### 9.2 Rate Limit

| 接口 | 限制 |
|------|------|
| GET /api/search | 60 次/分钟/IP |
| GET /api/doc/:id | 120 次/分钟/IP |
| GET /api/sources | 30 次/分钟/IP |
| 全局 | 1,000 次/天/IP |

每日总量上限防止被恶意爬取整个文档库。正常 Skill 使用场景下，单次会话约产生 5-15 次请求，1000 次/天足够覆盖重度使用。

### 9.3 管理接口认证

管理接口采用双重认证：

```
Authorization: Bearer <ADMIN_TOKEN>
```

- **Bearer Token**：ADMIN_TOKEN 通过环境变量注入，仅抓取脚本和运维操作使用
- **IP 白名单**（推荐）：通过 Cloudflare Access 或 Worker 中间件限制管理接口仅允许抓取服务器 IP 访问
- **Cloudflare Access**（可选）：如使用 Cloudflare 方案，可在 `/api/admin/*` 路由前配置 Access Policy

### 9.4 可选：用户认证（后续扩展）

如需支持私有文档源或用量计费，可后续添加：

```
Authorization: Bearer <USER_API_KEY>
```

Skill 中通过环境变量注入：

```markdown
如果设置了环境变量 SPECFUSION_API_KEY，在请求时添加 Header：
Authorization: Bearer ${SPECFUSION_API_KEY}
```

---

## 10. 开发阶段规划

### Phase 0：技术验证（开发前必做）

**目标**：验证核心技术假设，排除阻塞性风险

- [ ] **D1 FTS5 验证**：在 Cloudflare D1 上创建 FTS5 虚拟表，写入 1000 条中文预分词数据，验证 MATCH 查询和 bm25() 评分是否正常工作。如 D1 不支持 FTS5，需切换到自托管 SQLite 方案
- [ ] **jieba-wasm 冷启动测试**：在 Cloudflare Worker 中加载 `@aspect/jieba-wasm`（~1.5MB），测量冷启动耗时。如超过 2 秒，考虑：(a) 预热策略 (b) 查询端也用预分词 lookup 而非实时分词
- [ ] **WebFetch 行为测试**：用 Claude Code 的 WebFetch 工具请求一个返回 text/markdown 的 URL，确认返回内容是否被 AI 摘要截断或改写。如存在不可控的截断，需在 SKILL.md 中增加 `Bash(curl)` 兜底路径
- [ ] **Cookie 抓取稳定性**：用现有 wecom-scraper 抓取 50 篇文档，记录 CAPTCHA 触发频率和 Cookie 有效期

**交付物**：技术可行性报告，确认或调整技术方案

### Phase 1：核心 MVP

**目标**：跑通 Skill + 云端搜索的完整链路，含中文搜索和 OpenAPI 扩展能力

- [ ] 云端 API 骨架（Cloudflare Worker + D1）
- [ ] 数据库 Schema（含预分词列、结构化字段和搜索日志表）
- [ ] jieba 分词集成（scraper 端写入分词 + Worker 端查询分词 + 自定义用户词典 ~100 词）
- [ ] 搜索接口 `/search`（返回 Markdown 格式，支持 API 路径搜索和错误码搜索）
- [ ] 文档接口 `/doc/:id`（含 `?summary=true` 摘要模式）
- [ ] 文档源接口 `/sources`（返回 Markdown 格式）
- [ ] 企业微信文档抓取入库（迁移 `wecom-scraper.js` → `WecomSource`，含 dev_mode 提取、Cookie 健康检查、自适应限速）
- [ ] 飞书文档抓取入库（迁移 `feishu-scraper.js` → `FeishuSource`，含响应校验、未知标签兜底、事件名索引）
- [ ] OpenAPI 3.x 通用适配器 + Markdown 渲染器（含 `$ref` 递归、allOf/oneOf 处理、参数位置区分）
- [ ] 错误码表入库（从文档内容中提取错误码映射）
- [ ] 同步质量门控（文档数量异常检测）
- [ ] SKILL.md 编写（含上下文管理策略、降级方案、dev_mode 引导）
- [ ] 端到端验证：在 Claude Code 中通过 Skill 搜索并获取文档

**交付物**：可用的 Skill + 云端服务，覆盖企业微信、飞书文档，支持 OpenAPI 源接入

### Phase 2：同步自动化与质量保障

**目标**：实现自动化文档同步，建立搜索质量基线

- [ ] 同步调度器（CLI + Cron Trigger）
- [ ] 管理接口（upsert / bulk-upsert / reindex）+ IP 白名单
- [ ] 增量同步（content_hash 对比 + prev_content_hash 变更追踪）
- [ ] 同步日志和失败重试
- [ ] 健康检查和基础监控
- [ ] 搜索日志采集和基础分析（热门查询、无结果查询）
- [ ] 通过钉钉 OpenAPI spec 验证通用适配器

**交付物**：每日自动同步，文档保持最新，可监控搜索质量

### Phase 3：搜索优化与多源扩展

**目标**：优化搜索体验，扩展更多文档源

- [ ] 同义词表（API 术语映射，如 "token" ↔ "令牌"，"webhook" ↔ "回调"）
- [ ] 基于搜索日志的无结果查询分析，持续补充用户词典
- [ ] 搜索评分调优（基于搜索日志分析）
- [ ] 更多 OpenAPI 源接入（微信支付、Stripe 等）
- [ ] 文档源管理 CLI（add-source / remove-source / list-sources）
- [ ] sources.md 自动更新
- [ ] 飞书多语言支持（英文版本文档可选接入）

**交付物**：搜索质量持续提升，可通过一行命令接入任意 OpenAPI 文档

### Phase 4：发布与生态

**目标**：正式发布，建立用户基础

- [ ] Plugin 打包和发布（等 Plugin 生态成熟后）
- [ ] 使用统计和搜索分析仪表盘
- [ ] README 和使用文档
- [ ] 社区反馈收集和迭代

**交付物**：可公开分发的 Claude Code Skill / Plugin

---

## 11. 技术栈总结

| 层 | 技术 | 说明 |
|----|------|------|
| Skill | Markdown + YAML frontmatter | SKILL.md，~3 KB |
| 分发 | 手动安装 → 后续 Plugin | 初期复制 SKILL.md，后续 Plugin 分发 |
| API 运行时 | Cloudflare Worker (Hono) | 或 Fastify（自托管） |
| 数据库 | Cloudflare D1 (SQLite) | 全量数据（元数据 + Markdown 全文 + FTS 索引） |
| 全文检索 | FTS5 + jieba 预分词 | 写入时分词，查询时分词 |
| 中文分词 | nodejieba / @aspect/jieba-wasm | scraper 用 nodejieba，Worker 用 wasm 版 |
| 抓取脚本 | Node.js + TypeScript | 复用 doc-hub-mcp 的 scraper 代码 |
| 浏览器自动化 | Playwright | 仅 scraper 端使用，用户侧零依赖 |
| 构建工具 | tsup / esbuild | Worker 和 Scraper 通用 |
| Monorepo | npm workspaces | 或 Turborepo |

---

## 附录 A：FAQ

**Q：为什么选择 Skill 而不是 MCP Server？**

A：Skill 零配置，用户只需一个 SKILL.md 文件即可使用，Claude 自动发现并调用。MCP Server 需要用户配置进程、管理 stdio 通信、处理启动失败等运维问题。前身 doc-hub-mcp 的实际体验证明了 MCP 方案的痛点：安装体积 100MB+、Playwright 依赖过重、用户配置门槛高。对于"搜索 + 获取文档"这个场景，Skill + 云端 API 的组合已足够覆盖。

**Q：为什么搜索接口返回 Markdown 而不是 JSON？**

A：Skill 通过 WebFetch 工具调用云端 API。WebFetch 设计上是抓取网页内容的工具，内部会对响应做 AI 摘要处理，JSON 结构在这个过程中可能丢失字段或格式。返回格式化 Markdown 文本，Claude 可以直接阅读并理解，无需额外的 JSON 解析步骤。管理接口面向程序调用，仍返回 JSON。

**Q：为什么不用 R2 和 KV？**

A：当前文档总量约 7,000 篇，Markdown 全文直接存 D1 的 content 列（单行限制 1MB，单篇 API 文档远不会超过）。D1 FTS5 查询在边缘节点本身很快（~10ms），加 KV 缓存反而增加架构复杂度。简化到只用 D1 单数据库，降低运维负担。后续如文档量超 10 万篇再按需引入。

**Q：为什么中文分词要初期就做？**

A：SQLite FTS5 的 unicode61 tokenizer 对中文按单字切分，搜索"发送消息"会被拆成"发|送|消|息"四个单字，召回大量不相关结果。这不是"优化"而是"可用性"问题。用 jieba 预分词后，"发送消息"被切分为"发送|消息"两个词，FTS5 可以精确匹配，搜索质量有质的提升。

**Q：WebFetch 调用云端 API 是否可靠？**

A：WebFetch 是 Claude Code 的内置工具，对 HTTPS 请求支持良好。Cloudflare Worker 的 99.9% SLA 保证了可用性。降级方案是在 Skill 中提示 Claude 使用 `Bash(curl)` 作为备选，或直接引导用户访问官方文档站点。

**Q：搜索质量如何保证？**

A：搜索引擎使用 SQLite FTS5 的 BM25 算法 + jieba 中文分词做全文检索，叠加标题精确匹配加权、路径深度降权和时间衰减因子。通过搜索日志采集热门查询和无结果查询，持续调优评分参数和同义词表。

**Q：如何处理文档中的代码示例？**

A：代码示例作为 Markdown 原文存储，FTS5 可检索代码内容。Skill 指令中明确要求 Claude 保留原始代码格式展示。

**Q：如何接入一个新的 OpenAPI 文档源？**

A：只需一行命令：
```bash
node scrapers/dist/cli.js add-source \
  --id my-api --name "My API" --adapter openapi \
  --spec-url https://example.com/openapi.json
```
适配器会自动解析 OpenAPI spec，为每个 endpoint 生成一篇结构化的 Markdown 文档，经 jieba 分词后入库建索引。

**Q：与 doc-hub-mcp 的抓取代码如何复用？**

A：直接将 `wecom-scraper.js`（703 行）和 `feishu-scraper.js`（678 行）迁移到 `scrapers/src/sources/` 目录，用 `DocSource` 接口包裹。核心改造点仅有一个：输出目标从"写本地文件"改为"调用 `/api/admin/bulk-upsert`"。HTML 解析、Markdown 转换、Cookie 管理、并发控制等逻辑全部保留不变。

**Q：企业微信的 dev_mode 是什么？**

A：企业微信文档对同一个 API 可能有多个版本：自建应用（internal）、第三方应用（third_party）、服务商代开发（service_provider）。它们的接口路径可能相同，但请求参数和权限要求不同。通过 `dev_mode` 字段区分，搜索时可用 `mode` 参数过滤，避免看到不相关模式的文档。

**Q：错误码搜索怎么工作？**

A：搜索引擎检测到查询是纯数字（如 `60011`）或匹配 `errcode \d+` 模式时，会先在独立的 `error_codes` 表中精确匹配，找到对应的错误说明和关联文档。评分公式中错误码精确匹配权重为 50 分，确保结果置顶。

**Q：为什么需要 Phase 0 技术验证？**

A：三个核心技术假设存在风险：(1) D1 是否支持 FTS5 虚拟表和 bm25() 函数——Cloudflare 文档未明确说明；(2) jieba-wasm 在 Worker 中的冷启动耗时是否可接受——1.5MB 的 wasm 文件加载可能超过预期；(3) WebFetch 对 text/markdown 的处理是否保留原文——可能存在截断或改写。任何一个假设不成立都需要调整方案，提前验证可避免大量返工。

---

## 附录 B：改进记录

本方案基于初版设计，经过以下关键改进：

| 改进点 | 原方案 | 改进后 | 原因 |
|--------|--------|--------|------|
| 搜索接口格式 | 返回 JSON | 返回 Markdown | WebFetch 对 JSON 处理不可控，Markdown 直接可读 |
| 存储架构 | D1 + R2 + KV 三层 | 仅 D1 | 7000 篇文档无需复杂架构，降低运维成本 |
| 中文分词 | 初期 unicode61，后续优化 | 初期即用 jieba | unicode61 单字切分搜索不可用，属必备功能 |
| 文档获取 | 仅全文模式 | 全文 + 摘要模式 | 避免长文档浪费上下文 token |
| OpenAPI 优先级 | Phase 3 (P1) | Phase 1 (P0) | 最有杠杆率的扩展机制，钉钉等可直接复用 |
| 抓取代码 | 重新实现 | 迁移复用 doc-hub-mcp | 1400+ 行成熟代码，无需重写 |
| Skill 策略 | 简单搜索→全文 | 搜索→摘要→按需全文 | 上下文管理，避免溢出 |
| 管理接口安全 | 仅 Bearer Token | Token + IP 白名单 | 双重认证更安全 |
| 分发方式 | Plugin 优先 | 手动安装优先 | Plugin 生态尚不成熟 |
| 搜索评分 | 无路径降权 | 加入 path_depth_penalty | 泛搜时深层文档应降权 |
| 搜索日志 | 无 | search_log 表 | 用于分析和持续优化搜索质量 |
| 降级方案 | 无 | Skill 内置降级提示 | 云端不可用时引导用户访问官方文档 |
| 版本追踪 | 无 | prev_content_hash 列 | 追踪文档变更历史 |
| API 路径搜索 | 仅关键词搜索 | 支持 `/cgi-bin/xxx` 路径精确匹配 | 开发者常用路径查找接口 |
| 错误码搜索 | 无 | 独立 error_codes 表 + 精确匹配 | 排错场景高频需求 |
| dev_mode | 不区分 | 企业微信文档标记 internal/third_party/service_provider | 同名 API 不同模式下参数不同 |
| doc_type | 不区分 | 文档类型标记 + 搜索加权 | API 参考文档应优先于指南中的提及 |
| Cookie 健康检查 | 同步时才发现失败 | 同步前主动校验 Cookie 有效性 | 提前发现问题，避免空跑 |
| 自适应限速 | 固定 1200ms | 阶梯式限速（1200→1800→2500ms） | 减少连续抓取触发 CAPTCHA 的概率 |
| 同步质量门控 | 无 | 文档数量骤降 >10% 时暂停写入告警 | 防止网站改版导致静默数据丢失 |
| Phase 0 技术验证 | 直接开发 | 开发前验证 D1 FTS5、jieba-wasm、WebFetch 行为 | 排除阻塞性技术风险 |
| OpenAPI 增强 | 基础解析 | $ref 递归、allOf/oneOf、Swagger 2.0、参数位置 | 实际 spec 比示例复杂得多 |
| 飞书响应校验 | 不校验 | 验证 code=0 后再入库 | 防止 content=undefined 脏数据 |
| 每日请求上限 | 仅分钟级限流 | 1000 次/天/IP | 防止恶意爬取整个文档库 |
| 用户词典 Phase 1 | Phase 3 做 | Phase 1 即加入 ~100 个专有术语 | 默认词典不含平台术语，分词错误影响搜索 |
