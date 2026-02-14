# SpecFusion

**在 Claude Code 里直接搜企业微信、飞书、钉钉、淘宝开放平台的 API 文档。**

不用切浏览器，不用翻文档站——输入问题，拿到接口参数，继续写代码。

```
> 企业微信怎么发应用消息？

  搜索到 3 篇相关文档：
  1. 发送应用消息 — POST /cgi-bin/message/send
  2. 接收消息与事件 — 被动回复消息
  3. 消息类型及数据格式 — text/image/voice/...
```

## 为什么用 SpecFusion

- **不离开终端** — 写代码时直接问，Claude 帮你查文档、给出接口参数和示例
- **中文搜索准确** — jieba 分词 + FTS5 全文索引，`发送应用消息`、`access_token`、`40001` 都能搜到
- **15,600+ 篇文档** — 企业微信 ~2,680 篇 + 飞书 ~4,070 篇 + 钉钉 ~2,020 篇 + 淘宝 ~6,740 篇 + 小红书 ~100 篇，接口参数、错误码、事件订阅全覆盖
- **零配置** — 云端服务已部署好，安装 Skill 后即可使用，无需自建后端

## 安装

前提：已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。

### macOS / Linux

```bash
curl -fsSL --create-dirs -o ~/.claude/skills/specfusion/SKILL.md \
  https://raw.githubusercontent.com/wxkingstar/SpecFusion/main/skill/SKILL.md
```

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills\specfusion" | Out-Null
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/wxkingstar/SpecFusion/main/skill/SKILL.md" `
  -OutFile "$env:USERPROFILE\.claude\skills\specfusion\SKILL.md"
```

安装完成。打开 Claude Code，开始提问即可。

## 使用方式

**方式一：直接提问**（提到企业微信、飞书、钉钉、淘宝等关键词时自动触发）

```
> 飞书如何创建审批实例？
> 企业微信的 access_token 怎么获取？
> 钉钉怎么发工作通知？
> 淘宝商品发布接口怎么用？
> wecom webhook 怎么发消息？
```

**方式二：使用 `/specfusion` 命令**

```
> /specfusion 企业微信发送应用消息
> /specfusion feishu 获取用户列表
```

## 已接入平台

| 平台 | 文档数量 | 覆盖范围 |
|------|---------|---------|
| 企业微信 | ~2,680 | 服务端 API、客户端 API、应用开发 |
| 飞书 | ~4,070 | 服务端 API、事件订阅、小程序 |
| 钉钉 | ~2,020 | 企业内部应用、服务端 API、客户端 JSAPI |
| 淘宝开放平台 | ~6,740 | 商品、交易、物流、店铺、用户等 API |
| 小红书 | ~100 | 电商开放平台 API（订单、商品、售后、物流等） |

## 仅在当前项目安装

如果不想全局安装，可以安装到项目目录（将 `~` 换成 `.`）：

**macOS / Linux：**
```bash
curl -fsSL --create-dirs -o .claude/skills/specfusion/SKILL.md \
  https://raw.githubusercontent.com/wxkingstar/SpecFusion/main/skill/SKILL.md
```

**Windows (PowerShell)：**
```powershell
New-Item -ItemType Directory -Force -Path ".claude\skills\specfusion" | Out-Null
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/wxkingstar/SpecFusion/main/skill/SKILL.md" `
  -OutFile ".claude\skills\specfusion\SKILL.md"
```

---

## 自部署

默认使用公共云端服务，无需自部署。如果需要私有化部署或自定义数据源，可以自建。

### Docker 部署

```bash
docker build -t specfusion .

docker run -d \
  -p 3456:3456 \
  -v $(pwd)/data:/app/data \
  -e ADMIN_TOKEN=your-secret-token \
  --name specfusion \
  specfusion
```

启动后将 Skill 中的 API 地址替换为你的实例：

```bash
# macOS
sed -i '' 's|http://specfusion.inagora.org/api|http://your-host:3456/api|g' \
  ~/.claude/skills/specfusion/SKILL.md

# Linux
sed -i 's|http://specfusion.inagora.org/api|http://your-host:3456/api|g' \
  ~/.claude/skills/specfusion/SKILL.md
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3456` | 服务端口 |
| `DB_PATH` | `./data/specfusion.db` | SQLite 数据库路径 |
| `ADMIN_TOKEN` | `dev-token` | Admin API 认证令牌 |

### 文档同步

```bash
npm install
npm run sync -- --source feishu    # 同步飞书文档
npm run sync -- --source wecom     # 同步企业微信文档
npm run sync -- --source dingtalk  # 同步钉钉文档（需要 playwright）
npm run sync -- --source taobao    # 同步淘宝开放平台文档
```

同步完成后数据库文件位于 `data/specfusion.db`。

### 本地开发

```bash
npm install
npm run dev     # 启动开发服务器（热重载）
npm run build   # 构建
```

## API 参考

所有 API 返回 Markdown 纯文本（`Content-Type: text/markdown`），可直接阅读。

Base URL: `http://localhost:3456/api`（自部署）

| 端点 | 说明 |
|------|------|
| `GET /api/search?q=关键词&source=wecom&limit=5` | 搜索文档 |
| `GET /api/doc/{doc_id}` | 获取文档全文 |
| `GET /api/doc/{doc_id}?summary=true` | 获取文档摘要 |
| `GET /api/sources` | 查看已接入文档源 |
| `GET /api/categories?source=wecom` | 浏览文档分类 |
| `GET /api/recent?source=wecom&days=7` | 最近更新的文档 |
| `GET /api/health` | 健康检查（返回 JSON） |

### 搜索参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 搜索关键词（接口名、API 路径、错误码、功能概念） |
| `source` | 否 | 文档来源：`wecom` / `feishu` / `dingtalk` / `taobao` / `xiaohongshu` |
| `mode` | 否 | 开发模式（仅企业微信）：`internal` / `third_party` / `service_provider` |
| `limit` | 否 | 返回数量，默认 5，最大 20 |

## 技术栈

- **API**: Node.js + Fastify + better-sqlite3 + FTS5
- **中文分词**: nodejieba
- **Scraper**: cheerio + playwright
- **构建**: tsup + tsx

## 贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/xxx`)
3. 提交更改 (`git commit -m 'Add xxx'`)
4. 推送分支 (`git push origin feature/xxx`)
5. 创建 Pull Request

## License

[MIT](LICENSE)
