# SpecFusion

多源 API 文档融合搜索 Skill — 云端检索，零安装，即问即答

## 项目结构

```
specfusion/
├── api/          # 云端 API 服务（Fastify + SQLite）
├── scrapers/     # 文档抓取/同步脚本
├── skill/        # Skill 文件（SKILL.md + sources.md）
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

## 技术栈

- API：Node.js + Fastify + better-sqlite3 + FTS5
- 中文分词：nodejieba（开发阶段），@aspect/jieba-wasm（生产 Worker）
- Scraper：Node.js + TypeScript + cheerio + playwright
- 构建：tsup + tsx

## 关键设计

- 所有公开 API 返回 `text/markdown` 格式（非 JSON）
- 中文搜索使用 jieba 预分词 + FTS5 unicode61
- 数据库仅使用 SQLite（D1），不引入 R2/KV
- 详细设计见 SPECFUSION_PLAN.md
