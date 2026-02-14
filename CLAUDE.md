# SpecFusion

多源 API 文档融合搜索 Skill — 云端检索，零安装，即问即答

## 项目结构

```
specfusion/
├── api/            # API 服务（Fastify + SQLite）
├── scrapers/       # 文档抓取/同步脚本（仅本地使用，不部署到服务器）
├── scripts/        # 部署脚本
├── skill/          # Skill 文件（SKILL.md + sources.md）
├── data/           # SQLite 数据库（specfusion.db）
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

## 技术栈

- API：Node.js + Fastify + better-sqlite3 + FTS5
- 中文分词：nodejieba
- Scraper：Node.js + TypeScript + cheerio + playwright
- 构建：tsup + tsx

## 关键设计

- 所有公开 API 返回 `text/markdown` 格式（非 JSON），health 端点除外返回 JSON
- 中文搜索使用 jieba 预分词 + FTS5 unicode61
- 数据库仅使用 SQLite，不引入其他存储
- tsup 将 API 打包为单文件 `dist/index.js`，代码中用 `resolve(__dirname, '../../db/schema.sql')` 定位 schema，Docker 和旧 VPS 部署均通过 symlink 解决路径
- 详细设计见 SPECFUSION_PLAN.md

## 数据库路径

项目统一使用 `data/specfusion.db`（项目根目录）。dev 服务和 K8s 部署共用同一个文件，scraper 同步后可直接上传，无需合并。

## Playwright Scraper 编码规范

编写使用 Playwright 的 scraper 时，注意以下性能陷阱：

- **禁止在循环中用高 timeout 的 click/waitFor 探测元素是否存在**：`page.click('text=xxx', { timeout: 2000 })` 在元素不存在时会白等 2 秒。如果在每页导航后都尝试多次，累积开销巨大（N 页 × M 次 × timeout）。应只在首次加载时探测，或用 `page.locator().count()` 零等待判断
- **`fetchContent` 循环中用 `domcontentloaded` 而非 `networkidle`**：SPA 页面可能有持续的后台请求导致 networkidle 永远等不到。正确做法是 `waitUntil: 'domcontentloaded'` + `waitForSelector` 等待目标内容出现
- **单页面串行导航时，并发度必须设为 1**：Playwright 同一 page 实例不能并行 goto
