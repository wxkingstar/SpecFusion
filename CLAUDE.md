# SpecFusion

多源 API 文档融合搜索 Skill — 云端检索，零安装，即问即答

## 项目结构

```
SpecFusion/
├── api/            # API 服务（Fastify + SQLite）
├── scrapers/       # 文档抓取/同步脚本（仅本地使用，不部署到服务器）
├── scripts/        # 部署脚本
├── specfusion/     # Skill 文件（SKILL.md）
├── data/           # SQLite 数据库（specfusion.db）
├── Makefile        # K8s 部署 + 全量同步命令（make help 查看）
```

## 开发命令

```bash
# 安装依赖
npm install

# 启动 API 服务（开发模式，热重载）
npm run dev

# 运行文档同步
npm run sync -- --source feishu

# 构建
npm run build
```

## 部署

支持 Docker 和 Kubernetes 部署，详见 README.md 中的自部署指南。

## 官网

官网代码目录：`/Users/wangxin/work/node/specfusion-web`，部署在 Vercel 上。

## 技术栈

- API：Node.js + Fastify + better-sqlite3 + FTS5
- 中文分词：nodejieba
- Scraper：Node.js + TypeScript + cheerio + ego lite（浏览器抓取）
- 构建：tsup + tsx

## 关键设计

- 所有公开 API 返回 `text/markdown` 格式（非 JSON），health 端点除外返回 JSON
- 中文搜索使用 jieba 预分词 + FTS5 unicode61
- 数据库仅使用 SQLite，不引入其他存储
- tsup 将 API 打包为单文件 `dist/index.js`，代码中用 `resolve(__dirname, '../../db/schema.sql')` 定位 schema，Docker 和旧 VPS 部署均通过 symlink 解决路径
- 详细设计见 SPECFUSION_PLAN.md

## 数据库路径

项目统一使用 `data/specfusion.db`（项目根目录）。dev 服务和 K8s 部署共用同一个文件，scraper 同步后可直接上传，无需合并。

## 浏览器抓取：ego lite

需要浏览器的源（dingtalk / xiaohongshu / dewu / jd / wecom / pinduoduo）不再自己
`chromium.launch()`，而是复用 [ego lite](https://lite.ego.app/) 的浏览器 —— 带用户
登录态和真实浏览器指纹，反爬站点更不容易拦。

ego lite **不对外暴露 CDP 端口**，Playwright 的 `connectOverCDP` 走不通，只能通过
`ego-browser nodejs` 运行时。因此架构是：

```
scrapers/src/sources/*.ts
      ↓ EgoPage / EgoHttpClient（Playwright、axios 风格接口）
scrapers/src/utils/ego-page.ts
      ↓ HTTP
scripts/ego-bridge.mjs（常驻在 ego lite 的 Node 运行时里）
      ↓ ego helper
ego lite 浏览器
```

```bash
# 启动桥接（抓取前必须先起）
scripts/ego-bridge.sh                          # 默认 39222
scripts/ego-bridge.sh 39223 "另一个任务空间"    # 并发跑第二个源时

# 桥接地址通过 EGO_BRIDGE_URL 传给 scraper
EGO_BRIDGE_URL=http://127.0.0.1:39223 npx tsx scrapers/src/cli.ts sync jd
```

### 编码规范

- **一个桥接同时只能跑一个源**：一个桥接 = 一个 task space = 一个标签页，两个源共用
  会互相抢标签，报 `Inspected target navigated or closed`。并发抓取要各起各的端口 +
  task space
- **爬取一律用 `gotoAndWait` 在当前标签内导航**，不要用 `openOrReuseTab`：后者对每个
  新 URL 都开新标签，翻上千页会堆出上千标签拖垮浏览器
- **响应体要等 `Network.loadingFinished` 才能取**，在 `responseReceived` 时取会拿到
  空值，大接口尤其明显（京东曾因此目录从 6,294 篇掉到 3,534 篇）
- **改动浏览器层后，务必拿旧实现跑一次目录对照**再决定是否 prune，否则可能误删几千篇
- **`fetchContent` 循环中等目标选择器，而不是 networkidle**：SPA 页面的后台请求可能
  永不停歇
- **单页面串行导航时并发度必须为 1**（`SOURCE_CONCURRENCY`）

### 抓取节奏

所有源的请求间隔和重试退避都走 `scrapers/src/utils/pace.ts` 的 `delay()`，可用
`SPECFUSION_PACE` 统一放大倍率，给反爬严格的站点降速：

```bash
SPECFUSION_PACE=1.5 npx tsx scrapers/src/cli.ts sync taobao   # 间隔放大 1.5 倍
```

批量跑用 `scripts/sync-batch.sh <批次名> <源:PACE:超时秒> ...`（串行 + 按进程组
杀超时任务，避免留下孤儿进程）。

### 拼多多

文档接口在 `open-api.pinduoduo.com`，要 POST + 登录态 + `Anti-Content`（页面 JS 每次
现算的反爬令牌），脚本无法自己构造。因此走「驱动页面导航 + 捕获它自己发的响应」：

```bash
scripts/pdd-refresh.sh          # 刷新 scrapers/data/pdd_api_docs.json
npx tsx scrapers/src/cli.ts sync pinduoduo
```

刷新前需先在 ego lite 里登录 open.pinduoduo.com。
