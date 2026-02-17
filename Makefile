# SpecFusion — K8s 部署 Makefile
#
# 常用命令:
#   make deploy      — 构建镜像 + 推送 + 滚动重启
#   make upload-db   — 上传本地数据库到 K8s PVC
#   make release     — deploy + upload-db 一步到位
#   make sync        — 运行所有 scraper（需先 npm run dev）
#   make logs        — 查看实时日志
#   make status      — Pod 状态 + 健康检查

# ─── 配置 ───────────────────────────────────────────
IMAGE       := docker.inagora.org/ai-infra/specfusion
TAG         := latest
K8S_CTX     := ol3
K8S_NS      := ai-infra
DEPLOY_NAME := specfusion
PVC_NAME    := specfusion-data-pvc
HEALTH_URL  := http://specfusion.inagora.org/api/health

DB_FILE     := data/specfusion.db
UPLOAD_POD  := specfusion-upload

KC          := kubectl --context $(K8S_CTX) -n $(K8S_NS)

# ─── 代码发布 ──────────────────────────────────────
.PHONY: deploy build push restart verify

deploy: build push restart verify ## 构建镜像 + 推送 + 重启 + 验证

build: ## 构建 Docker 镜像 (linux/amd64)
	docker build --platform linux/amd64 -t $(IMAGE):$(TAG) .

push: ## 推送镜像到内部仓库
	docker push $(IMAGE):$(TAG)

restart: ## 滚动重启 Deployment 并等待就绪
	$(KC) rollout restart deployment/$(DEPLOY_NAME)
	$(KC) rollout status deployment/$(DEPLOY_NAME) --timeout=120s

verify: ## 健康检查（最多重试 30s）
	@for i in 1 2 3 4 5 6; do \
		sleep 5; \
		if curl -sf $(HEALTH_URL) > /dev/null 2>&1; then \
			echo "✓ 服务正常"; \
			curl -s $(HEALTH_URL); \
			exit 0; \
		fi; \
		echo "  等待服务就绪... ($$i/6)"; \
	done; \
	echo "✗ 健康检查失败"; exit 1

# ─── 文档同步（需先 npm run dev 启动本地服务）──────
.PHONY: sync sync-feishu sync-wecom sync-dingtalk sync-xiaohongshu sync-taobao sync-douyin sync-wechat-miniprogram sync-wechat-shop sync-pinduoduo sync-youzan

sync: sync-feishu sync-wecom sync-dingtalk sync-xiaohongshu sync-taobao sync-douyin sync-wechat-miniprogram sync-wechat-shop sync-pinduoduo sync-youzan ## 同步全部源到 data/specfusion.db

sync-feishu: ## 同步飞书文档
	npm run sync -- --source feishu

sync-wecom: ## 同步企业微信文档
	npm run sync -- --source wecom

sync-dingtalk: ## 同步钉钉文档
	npm run sync -- --source dingtalk

sync-xiaohongshu: ## 同步小红书文档
	npm run sync -- --source xiaohongshu

sync-taobao: ## 同步淘宝开放平台文档
	npm run sync -- --source taobao

sync-douyin: ## 同步抖音电商开放平台文档
	npm run sync -- --source douyin

sync-wechat-miniprogram: ## 同步微信小程序文档
	npm run sync -- --source wechat-miniprogram

sync-wechat-shop: ## 同步微信小店文档
	npm run sync -- --source wechat-shop

sync-pinduoduo: ## 同步拼多多开放平台文档（需先导出 JSON 到 scrapers/data/）
	npm run sync -- --source pinduoduo

sync-youzan: ## 同步有赞开放平台文档
	npm run sync -- --source youzan

# ─── 数据库上传到 K8s ────────────────────────────────
.PHONY: upload-db

upload-db: ## 上传 data/specfusion.db 到 K8s PVC
	@test -f $(DB_FILE) || { echo "✗ $(DB_FILE) 不存在，先运行 make sync"; exit 1; }
	@echo "==> WAL checkpoint..."
	@sqlite3 $(DB_FILE) "PRAGMA wal_checkpoint(TRUNCATE);" > /dev/null
	@echo "==> 数据库大小: $$(ls -lh $(DB_FILE) | awk '{print $$5}')"
	@echo "==> Scale down $(DEPLOY_NAME)..."
	$(KC) scale deployment/$(DEPLOY_NAME) --replicas=0
	@$(KC) wait pod -l app=$(DEPLOY_NAME) --for=delete --timeout=60s 2>/dev/null || true
	@echo "==> 创建临时 Pod 挂载 PVC..."
	$(KC) run $(UPLOAD_POD) --image=busybox --restart=Never \
		--overrides='{"spec":{"containers":[{"name":"upload","image":"busybox","command":["sleep","3600"],"volumeMounts":[{"name":"data","mountPath":"/app/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"$(PVC_NAME)"}}]}}'
	$(KC) wait pod/$(UPLOAD_POD) --for=condition=Ready --timeout=60s
	@echo "==> 清理旧 WAL 文件..."
	$(KC) exec $(UPLOAD_POD) -- rm -f /app/data/specfusion.db-wal /app/data/specfusion.db-shm
	@echo "==> 上传数据库..."
	$(KC) cp $(DB_FILE) $(K8S_NS)/$(UPLOAD_POD):/app/data/specfusion.db
	@echo "==> 清理临时 Pod..."
	$(KC) delete pod $(UPLOAD_POD) --wait=true
	@echo "==> Scale up $(DEPLOY_NAME)..."
	$(KC) scale deployment/$(DEPLOY_NAME) --replicas=1
	$(KC) rollout status deployment/$(DEPLOY_NAME) --timeout=120s
	@echo "✓ 数据库上传完成"

# ─── 完整发布 ─────────────────────────────────────
.PHONY: release

release: deploy upload-db verify ## 代码 + 数据库一起发布

# ─── 运维 ─────────────────────────────────────────
.PHONY: logs shell status health

logs: ## 查看实时日志
	$(KC) logs -f deployment/$(DEPLOY_NAME)

shell: ## 进入 Pod 调试
	$(KC) exec -it deployment/$(DEPLOY_NAME) -- sh

status: ## Pod 状态 + 健康检查
	@$(KC) get pods -l app=$(DEPLOY_NAME) -o wide
	@echo "---"
	@curl -sf $(HEALTH_URL) || echo "服务不可达"

health: ## 健康检查
	@curl -sf $(HEALTH_URL) && echo || echo "服务不可达"

# ─── 帮助 ─────────────────────────────────────────
.PHONY: help

help: ## 显示所有命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
