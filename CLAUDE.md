# SpecFusion

多源 API 文档融合搜索 Skill — 云端检索，零安装，即问即答

## 项目结构

```
specfusion/
├── api/            # API 服务（Fastify + SQLite）
├── scrapers/       # 文档抓取/同步脚本（仅本地使用，不部署到服务器）
├── scripts/        # 部署脚本与 systemd 服务配置
├── skill/          # Skill 文件（SKILL.md + sources.md）
├── data/           # SQLite 数据库（specfusion.db，~56MB）
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

生产环境运行在 `specfusion.inagora.org`（K8s 集群）。

镜像仓库：`your-registry.example.com/specfusion`

K8s 清单位置：`~/work/k8s-manifests/specfusion/`

### 日常发布（代码变更）

```bash
# 1. 构建并推送镜像
docker build --platform linux/amd64 -t your-registry.example.com/specfusion:latest .
docker push your-registry.example.com/specfusion:latest

# 2. 滚动重启（拉取最新镜像）
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE rollout restart deployment/specfusion

# 3. 验证
curl http://specfusion.inagora.org/api/health
```

### 更新数据库（文档同步后）

```bash
# 1. 本地同步文档
npm run sync -- --source feishu
npm run sync -- --source wecom

# 2. Scale down → 上传 → Scale up（避免 SQLite WAL 冲突）
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE scale deployment/specfusion --replicas=0
# 等 Pod 终止后：
kubectl --context YOUR_CLUSTERrun specfusion-upload -n YOUR_NAMESPACE--image=busybox --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"specfusion-upload","image":"busybox","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/app/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"specfusion-pvc"}}]}}'
# 等 Pod Running 后：
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE exec specfusion-upload -- rm -f /app/data/specfusion.db-wal /app/data/specfusion.db-shm
kubectl --context YOUR_CLUSTERcp data/specfusion.db YOUR_NAMESPACE/specfusion-upload:/app/data/specfusion.db
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE delete pod specfusion-upload
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE scale deployment/specfusion --replicas=1
```

### 修改 K8s 配置（资源/环境变量/Ingress 等）

```bash
kubectl --context YOUR_CLUSTERapply -k ~/work/k8s-manifests/specfusion/
```

### 运维命令

```bash
# 查看 Pod 状态
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE get pods -l app=specfusion

# 查看实时日志
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE logs -f deployment/specfusion

# 进入 Pod 调试
kubectl --context YOUR_CLUSTER -n YOUR_NAMESPACE exec -it deployment/specfusion -- sh

# 验证服务
curl http://specfusion.inagora.org/api/health
curl "http://specfusion.inagora.org/api/search?q=access_token"
```

### 旧 VPS 部署（已废弃，脚本保留）

旧的 systemd 部署脚本在 `scripts/deploy.sh`，目标服务器 `your-server.example.com`。

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
