#!/bin/bash
# 等某个进程跑完再启动下一批同步，用来把多个源排进同一条通道，
# 避免多路并发抢 SQLite 写锁（详见 memory: full-resync-pitfalls）。
#
#   scripts/sync-queue.sh <等待的进程匹配串> <批次名> <源:PACE:超时> ...

set -u

WAIT_FOR="$1"; shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[queue] 等待 \"$WAIT_FOR\" 结束..."
while pgrep -f "$WAIT_FOR" > /dev/null; do
  sleep 30
done
echo "[queue] 通道已空闲，启动下一批"

exec bash scripts/sync-batch.sh "$@"
