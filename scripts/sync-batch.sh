#!/bin/bash
# 串行跑一批文档源同步。
#
#   scripts/sync-batch.sh <批次名> <源:PACE:超时秒> ...
#
# 例：scripts/sync-batch.sh fast feishu:1:5400 weaver:1:1800
#
# 每个源单独一个进程组（set -m），超时按 pgid 群发信号，避免
# npm → tsx → chromium 进程链变孤儿继续抢网络/数据库。

set -u

BATCH="$1"; shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="${SYNC_LOGDIR:-$ROOT/.sync-logs}"
mkdir -p "$LOGDIR"
SUMMARY="$LOGDIR/${BATCH}-summary.txt"

cd "$ROOT"
set -m

echo "=== 批次 $BATCH 开始 $(date '+%F %T') ===" | tee -a "$SUMMARY"

for spec in "$@"; do
  src="${spec%%:*}"
  rest="${spec#*:}"
  pace="${rest%%:*}"
  timeout="${rest##*:}"
  log="$LOGDIR/$src.log"

  echo "--- $src (PACE=$pace, timeout=${timeout}s) 开始 $(date '+%F %T') ---" | tee -a "$SUMMARY"
  start=$(date +%s)

  SPECFUSION_PACE="$pace" npx tsx scrapers/src/cli.ts sync "$src" > "$log" 2>&1 &
  pid=$!

  ( sleep "$timeout"; kill -TERM -- -"$pid" 2>/dev/null; sleep 10; kill -KILL -- -"$pid" 2>/dev/null ) &
  watchdog=$!

  wait "$pid"; code=$?
  kill "$watchdog" 2>/dev/null

  # Playwright 源残留兜底
  pkill -9 -f 'chrome-headless-shell' 2>/dev/null

  elapsed=$(( $(date +%s) - start ))
  stats=$(grep -E '^  (新增|更新|未变|错误):' "$log" | tail -4 | tr -d ' ' | tr '\n' ' ')
  printf '%s\n' "    $src: exit=$code 耗时=${elapsed}s $stats" | tee -a "$SUMMARY"
done

echo "=== 批次 $BATCH 结束 $(date '+%F %T') ===" | tee -a "$SUMMARY"
