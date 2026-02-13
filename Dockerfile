# ---- Build Stage ----
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制 workspace 根配置
COPY package.json package-lock.json ./

# 创建 scrapers stub，避免 npm workspace 拉取 playwright 等重依赖
RUN mkdir -p scrapers && echo '{"name":"@specfusion/scrapers","version":"0.1.0","private":true}' > scrapers/package.json

# 复制 api workspace
COPY api/package.json api/

# 安装所有依赖（含 devDependencies 用于编译）
RUN npm ci --workspace=api

# 复制 tsconfig 和 api 源码并构建（跳过 --dts，生产环境不需要类型声明）
COPY tsconfig.base.json ./
COPY api/ api/
RUN cd api && npx tsup src/index.ts --format esm

# 裁剪 devDependencies，保留已编译的 native addons
RUN npm prune --omit=dev --workspace=api

# ---- Runtime Stage ----
FROM node:20-slim

RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 从 builder 复制裁剪后的 node_modules（含已编译的 native addons）
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY api/package.json api/

# 从 builder 复制构建产物
COPY --from=builder /app/api/dist/ api/dist/

# 复制 schema 和 nodejieba 自定义词典
COPY api/db/schema.sql api/db/schema.sql
COPY scrapers/config/userdict.txt scrapers/config/userdict.txt

# symlink：修复 resolve(__dirname, '../../db/schema.sql') 路径解析
# tsup 打包后 __dirname = /app/api/dist，解析为 /app/db/schema.sql
RUN ln -sf /app/api/db /app/db

# 数据目录（用于挂载 PVC）
RUN mkdir -p /app/data

WORKDIR /app/api

EXPOSE 3456

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
