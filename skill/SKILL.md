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

Base URL: `http://localhost:3456/api`

> 部署到生产环境后，替换为 `https://specfusion.your-domain.com/api`

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

返回格式为 Markdown 纯文本（非 JSON），可直接阅读。

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
- 单次对话中建议不超过 3 篇全文，超过时提示用户上下文可能不足（软限制）
- 如果用户问题涉及多个接口，分多次搜索，每次聚焦一个
- 如果 WebFetch 返回的全文看起来被截断，用 `Bash(curl)` 重试获取原始完整内容

## 注意事项

- 优先搜索具体 API 名称，泛搜效果差（"发送应用消息" 优于 "消息"）
- 如果用户提供了完整的 API 路径（如 `/cgi-bin/message/send`），直接按路径搜索
- 首次搜索不理想时，尝试同义词或换个角度的关键词
- 回答时注明文档来源（如"根据企业微信文档《发送应用消息》..."）
- 企业微信文档区分开发模式：搜到多篇同名文档时，确认用户是自建应用、第三方应用还是服务商代开发，加 `mode` 参数过滤
- 文档内容可能包含代码示例，保留原始格式展示给用户
- 跨平台对比：当用户问对比问题时，分别搜索两个平台，做对比展示

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
