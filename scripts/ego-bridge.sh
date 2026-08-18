#!/bin/bash
# 启动 ego-lite 浏览器桥接。
#
#   scripts/ego-bridge.sh [端口] [任务空间名]
#
# ego 的 Node 运行时不继承父进程环境变量，所以端口和任务空间名
# 在这里用占位符替换后再通过管道喂给 `ego-browser nodejs`。

#
# ego lite 会不定期回收它的 Node 运行时（日志里表现为 NodeRuntime disconnected），
# 桥接跟着一起死。抓一个源要几小时，中途死掉会让后续文档全部失败，
# 所以这里常驻一个看护循环自动拉起；只有收到 /shutdown 才真正退出。

set -u

PORT="${1:-39222}"
SPACE="${2:-specfusion 文档抓取}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLAG="/tmp/ego-bridge-$PORT.stop"

rm -f "$FLAG"

while true; do
  sed -e "s|__PORT__|$PORT|g" -e "s|__TASK_SPACE__|$SPACE|g" "$ROOT/scripts/ego-bridge.mjs" \
    | ego-browser nodejs
  code=$?

  if [ -f "$FLAG" ]; then
    echo "[bridge] 收到停止标记，退出看护"
    rm -f "$FLAG"
    exit 0
  fi

  # 变量名必须用 ${} 界定：紧跟中文全角括号时 bash 会把多字节字符当成变量名的一部分
  echo "[bridge] 运行时退出 (code=${code})，3 秒后重启..."
  sleep 3
done
