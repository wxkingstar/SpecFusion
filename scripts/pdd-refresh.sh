#!/bin/bash
# 用 ego lite 刷新拼多多文档数据（需要先在 ego lite 里登录 open.pinduoduo.com）。
#
#   scripts/pdd-refresh.sh [输出 JSON 路径]
#
# ego 运行时不继承父进程环境变量，路径靠占位符替换传入。

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON_PATH="${1:-$ROOT/scrapers/data/pdd_api_docs.json}"

test -f "$JSON_PATH" || { echo "✗ 找不到 $JSON_PATH（需要旧数据提供分类种子）"; exit 1; }

cp "$JSON_PATH" "$JSON_PATH.bak"
echo "==> 已备份到 $JSON_PATH.bak"

sed -e "s|__JSON_PATH__|$JSON_PATH|g" "$ROOT/scripts/pdd-refresh.mjs" | ego-browser nodejs
