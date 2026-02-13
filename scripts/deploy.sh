#!/usr/bin/env bash
set -euo pipefail

# SpecFusion 部署脚本
# 用法:
#   npm run deploy            # 日常部署（编译+同步代码+重启）
#   npm run deploy -- --init  # 首次部署（安装 Node.js、systemd、上传数据库）
#   npm run deploy -- --db    # 日常部署 + 重新上传数据库

REMOTE_HOST="${DEPLOY_HOST:?请设置 DEPLOY_HOST 环境变量，例如 user@your-server.com}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/specfusion}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 解析参数
INIT=false
SYNC_DB=false
for arg in "$@"; do
  case "$arg" in
    --init) INIT=true; SYNC_DB=true ;;
    --db)   SYNC_DB=true ;;
  esac
done

log() { echo "==> $1"; }

# ---------- 首次部署 ----------
if $INIT; then
  log "首次部署：安装远程环境..."

  ssh "$REMOTE_HOST" bash -s <<'INIT_SCRIPT'
set -euo pipefail

# 安装 rsync（如果未安装）
if ! command -v rsync &>/dev/null; then
  echo "==> 安装 rsync..."
  apt-get update -qq && apt-get install -y -qq rsync
fi

# 安装 Node.js 20（如果未安装）
if ! command -v node &>/dev/null; then
  echo "==> 安装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Node.js $(node --version), npm $(npm --version)"

# 创建目录结构
mkdir -p /opt/specfusion/{api,data}

# 创建 symlink：tsup 打包后 __dirname 是 dist/，代码用 resolve(__dirname, '../../db/schema.sql')
# 所以需要 /opt/specfusion/db -> /opt/specfusion/api/db
ln -sf /opt/specfusion/api/db /opt/specfusion/db

INIT_SCRIPT

  # 部署 systemd 服务文件
  log "部署 systemd 服务..."
  scp "$PROJECT_ROOT/scripts/specfusion.service" "$REMOTE_HOST:/etc/systemd/system/specfusion.service"
  ssh "$REMOTE_HOST" "systemctl daemon-reload && systemctl enable specfusion"

  log "远程环境初始化完成"
fi

# ---------- 本地编译 ----------
log "本地编译 API..."
cd "$PROJECT_ROOT"
npm run build --workspace=api

# ---------- 同步代码 ----------
log "同步代码到远程..."
rsync -avz --delete \
  --exclude='node_modules' \
  "$PROJECT_ROOT/api/dist/" "$REMOTE_HOST:$REMOTE_DIR/api/dist/"

rsync -avz \
  "$PROJECT_ROOT/api/package.json" "$REMOTE_HOST:$REMOTE_DIR/api/package.json"

rsync -avz \
  "$PROJECT_ROOT/api/package-lock.json" "$REMOTE_HOST:$REMOTE_DIR/api/package-lock.json" \
  2>/dev/null || true

rsync -avz \
  "$PROJECT_ROOT/api/db/" "$REMOTE_HOST:$REMOTE_DIR/api/db/"

# ---------- 同步数据库 ----------
if $SYNC_DB; then
  log "上传数据库文件..."
  # 先做 WAL checkpoint 确保数据完整
  cd "$PROJECT_ROOT"
  node -e "
    const Database = require('better-sqlite3');
    const db = new Database('data/specfusion.db');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('WAL checkpoint done');
  " 2>/dev/null || echo "WAL checkpoint skipped (无 better-sqlite3 全局安装)"
  # 先停服务再上传，避免 SQLite 文件损坏
  ssh "$REMOTE_HOST" "systemctl stop specfusion" 2>/dev/null || true
  rsync -avz --progress \
    "$PROJECT_ROOT/data/specfusion.db" "$REMOTE_HOST:$REMOTE_DIR/data/specfusion.db"
fi

# ---------- 远程安装依赖 + 重启 ----------
log "远程安装依赖..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR/api && npm install --omit=dev"

log "重启服务..."
ssh "$REMOTE_HOST" "systemctl restart specfusion"

# ---------- 健康检查 ----------
log "等待服务启动..."
sleep 2
HEALTH=$(ssh "$REMOTE_HOST" "curl -s http://localhost:3456/api/health" 2>/dev/null || echo "FAIL")
echo "$HEALTH"

if echo "$HEALTH" | grep -q "total_docs"; then
  log "部署成功！"
else
  log "警告：健康检查未通过，请检查日志：ssh $REMOTE_HOST journalctl -u specfusion -n 50"
fi
