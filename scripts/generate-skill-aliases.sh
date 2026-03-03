#!/bin/bash
# Generate platform-specific skill aliases from the main specfusion SKILL.md
# Each alias has a different name for search discoverability on skills.sh
# Usage: ./scripts/generate-skill-aliases.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$REPO_ROOT"
MAIN_SKILL="$SKILLS_DIR/specfusion/SKILL.md"

if [ ! -f "$MAIN_SKILL" ]; then
  echo "Error: Main SKILL.md not found at $MAIN_SKILL"
  exit 1
fi

# Extract the body content (everything after the YAML frontmatter closing ---)
BODY=$(awk 'BEGIN{n=0} /^---$/{n++; if(n==2){found=1; next}} found{print}' "$MAIN_SKILL")

# Platform definitions: directory_name|skill_name|description
# skill_name is what skills.sh indexes for search
PLATFORMS=(
  "wecom-企业微信-api|wecom-企业微信-api-docs|Search WeCom (企业微信) API documentation. 2,680+ docs covering server API, client API, and app development. Powered by SpecFusion."
  "feishu-飞书-api|feishu-飞书-api-docs|Search Feishu/Lark (飞书) API documentation. 4,070+ docs covering server API, event subscriptions, and mini programs. Powered by SpecFusion."
  "lark-api|lark-api-docs|Search Lark/Feishu (飞书) API documentation. 4,070+ docs. Alias for feishu. Powered by SpecFusion."
  "dingtalk-钉钉-api|dingtalk-钉钉-api-docs|Search DingTalk (钉钉) API documentation. 2,020+ docs covering enterprise apps, server API, and client JSAPI. Powered by SpecFusion."
  "taobao-淘宝-api|taobao-淘宝-api-docs|Search Taobao (淘宝开放平台) API documentation. 6,740+ docs covering products, trades, logistics, and more. Powered by SpecFusion."
  "xiaohongshu-小红书-api|xiaohongshu-小红书-api-docs|Search Xiaohongshu (小红书) API documentation. 100+ docs covering e-commerce open platform API. Powered by SpecFusion."
  "douyin-抖音电商-api|douyin-抖音电商-api-docs|Search Douyin E-commerce (抖音电商开放平台) API documentation. 1,280+ docs covering products, orders, logistics, and more. Powered by SpecFusion."
  "wechat-miniprogram-微信小程序-api|wechat-miniprogram-微信小程序-api-docs|Search WeChat Mini Program (微信小程序) API documentation. 280+ server API docs. Powered by SpecFusion."
  "wechat-shop-微信小店-api|wechat-shop-微信小店-api-docs|Search WeChat Shop (微信小店) API documentation. 480+ docs covering products, orders, logistics, and settlements. Powered by SpecFusion."
  "pinduoduo-拼多多-api|pinduoduo-拼多多-api-docs|Search Pinduoduo (拼多多开放平台) API documentation. 280+ docs covering orders, products, logistics, and marketing. Powered by SpecFusion."
  "youzan-有赞-api|youzan-有赞-api-docs|Search Youzan (有赞开放平台) API documentation. 1,240+ docs covering users, products, trades, and marketing. Powered by SpecFusion."
  "wechat-pay-微信支付-api|wechat-pay-微信支付-api-docs|Search WeChat Pay (微信支付) API documentation. 540+ docs covering JSAPI, APP, H5, Native payments, refunds, and more. Powered by SpecFusion."
  "alipay-支付宝-api|alipay-支付宝-api-docs|Search Alipay (支付宝开放平台) API documentation. 600+ docs covering payments, funds, members, and marketing. Powered by SpecFusion."
  "jd-京东-api|jd-京东-api-docs|Search JD (京东商家开放平台) API documentation. 6,100+ docs covering products, orders, logistics, promotions, and data. Powered by SpecFusion."
  "shein-api|shein-api-docs|Search SHEIN Open Platform API documentation. 190+ docs covering products, orders, returns, inventory, and logistics. Powered by SpecFusion."
  "dewu-得物-api|dewu-得物-api-docs|Search Dewu (得物开放平台) API documentation. 260+ docs covering products, orders, after-sales, and settlements. Powered by SpecFusion."
)

created=0
updated=0

for platform in "${PLATFORMS[@]}"; do
  IFS='|' read -r dir_name skill_name description <<< "$platform"

  skill_dir="$SKILLS_DIR/$dir_name"
  skill_file="$skill_dir/SKILL.md"

  mkdir -p "$skill_dir"

  cat > "$skill_file" << SKILLEOF
---
name: $skill_name
description: |
  $description
  搜索企业微信、飞书、钉钉、淘宝开放平台、小红书、抖音电商开放平台、微信小程序、微信小店、拼多多开放平台、有赞开放平台、微信支付、支付宝开放平台、京东商家开放平台、SHEIN开放平台、得物开放平台等开放平台的 API 文档。26,000+ 篇文档，支持中文全文搜索。
user-invocable: true
argument-hint: "企业微信发送消息 / feishu 审批 / 淘宝商品发布 / 小红书订单 / 抖音电商订单 / 微信小程序登录 / 微信小店订单 / 拼多多订单 / 有赞交易 / 微信支付JSAPI下单 / 支付宝当面付 / 京东商品API / SHEIN商品发布 / 得物订单 / 搜索关键词"
allowed-tools: Bash, Read
---
$BODY
SKILLEOF

  if [ -f "$skill_file" ]; then
    ((updated++))
    echo "  ✓ $skill_name -> $dir_name/"
  fi
done

echo ""
echo "Done! Generated $updated platform aliases in $SKILLS_DIR/"
echo ""
echo "Verify with: npx skills add . -l"
echo "Then commit and push to GitHub."
