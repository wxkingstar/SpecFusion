# SpecFusion

多源 API 文档融合搜索 — 让 Claude 直接查 API 文档，云端检索，零安装，即问即答。

- **中文搜索优化** — jieba 分词 + SQLite FTS5，中英文混合搜索精准匹配
- **多平台覆盖** — 企业微信 ~2,760 篇 + 飞书 ~4,095 篇，持续接入更多平台
- **Claude Skill 即装即用** — 一条命令安装，对话中直接搜索 API 文档
- **可自部署** — Docker 一键启动，自建文档搜索服务

## Skill 快速安装

SpecFusion 作为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的 Skill 使用，安装后可在对话中直接搜索 API 文档。

### 一键安装（全局）

```bash
curl -fsSL --create-dirs -o ~/.claude/skills/specfusion/SKILL.md \
  https://raw.githubusercontent.com/wxkingstar/SpecFusion/main/skill/SKILL.md
```

安装完成后，在 Claude Code 中即可使用 `/specfusion` 命令或在对话中提及企业微信、飞书等关键词时自动触发。

### 使用示例

```
> /specfusion 企业微信发送应用消息

> 飞书如何创建审批实例？

> 企业微信的 access_token 怎么获取？
```

### 仅在当前项目安装

```bash
curl -fsSL --create-dirs -o .claude/skills/specfusion/SKILL.md \
  https://raw.githubusercontent.com/wxkingstar/SpecFusion/main/skill/SKILL.md
```

### 指向自部署实例

默认使用公共 API `http://specfusion.inagora.org/api`。如果你自部署了 SpecFusion，编辑安装后的 SKILL.md，将 API 地址替换为你的实例地址：

```bash
sed -i '' 's|http://specfusion.inagora.org/api|http://your-host:3456/api|g' \
  ~/.claude/skills/specfusion/SKILL.md
```

## 已接入平台

| 平台 | source 参数 | 文档数量 | 覆盖范围 |
|------|-----------|---------|---------|
| 企业微信 | `wecom` | ~2,760 | 服务端 API、客户端 API、应用开发 |
| 飞书 | `feishu` | ~4,095 | 服务端 API、事件订阅、小程序 |
| 钉钉 | `dingtalk` | 计划接入 | — |
| 微信支付 | `wxpay` | 计划接入 | — |

## API 参考

所有公开 API 返回 **Markdown 纯文本**（非 JSON），可直接阅读。health 端点例外，返回 JSON。

Base URL: `http://localhost:3456/api`（自部署）或 `http://specfusion.inagora.org/api`（公共实例）

### 搜索文档

```bash
curl -s -G "http://localhost:3456/api/search" \
  --data-urlencode "q=发送应用消息" -d "source=wecom" -d "limit=5"
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `q` | 是 | 搜索关键词（接口名、API 路径、错误码、功能概念） |
| `source` | 否 | 文档来源过滤：`wecom` / `feishu` |
| `mode` | 否 | 开发模式（仅企业微信）：`internal` / `third_party` / `service_provider` |
| `limit` | 否 | 返回数量，默认 5，最大 20 |

### 获取文档内容

```bash
curl -s "http://localhost:3456/api/doc/{doc_id}"                  # 全文
curl -s "http://localhost:3456/api/doc/{doc_id}?summary=true"     # 摘要
```

### 查看文档源

```bash
curl -s "http://localhost:3456/api/sources"
```

### 浏览分类

```bash
curl -s "http://localhost:3456/api/categories?source=wecom"
curl -s "http://localhost:3456/api/categories/wecom/001-企业内部开发"
```

### 最近更新

```bash
curl -s -G "http://localhost:3456/api/recent" \
  -d "source=wecom" -d "days=7" -d "limit=20"
```

### 健康检查

```bash
curl -s "http://localhost:3456/api/health"
```

## 自部署指南

### 前置要求

- Node.js >= 20.18.0
- npm

### Docker 部署（推荐）

```bash
# 构建镜像
docker build -t specfusion .

# 运行（数据库挂载到宿主机）
docker run -d \
  -p 3456:3456 \
  -v $(pwd)/data:/app/data \
  -e ADMIN_TOKEN=your-secret-token \
  --name specfusion \
  specfusion
```

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器（热重载）
npm run dev

# 构建
npm run build
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3456` | 服务端口 |
| `DB_PATH` | `./data/specfusion.db` | SQLite 数据库路径 |
| `ADMIN_TOKEN` | `dev-token` | Admin API 认证令牌（用于文档同步接口，生产环境务必修改） |

## 文档抓取

Scraper 用于将开放平台文档同步到本地 SQLite 数据库。

```bash
# 同步飞书文档
npm run sync -- --source feishu

# 同步企业微信文档
npm run sync -- --source wecom
```

同步完成后数据库文件位于 `data/specfusion.db`。

## 项目结构

```
specfusion/
├── api/            # API 服务（Fastify + SQLite FTS5）
├── scrapers/       # 文档抓取/同步脚本
├── scripts/        # 部署脚本
├── skill/          # Claude Code Skill 文件
├── data/           # SQLite 数据库
├── Dockerfile      # 容器化配置
└── package.json    # Workspace 根配置
```

## 技术栈

- **API**: Node.js + Fastify + better-sqlite3 + FTS5
- **中文分词**: nodejieba
- **Scraper**: Node.js + TypeScript + cheerio + playwright
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
