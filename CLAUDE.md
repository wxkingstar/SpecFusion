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
