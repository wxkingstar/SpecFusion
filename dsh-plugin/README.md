# @wxkingstar/specfusion-dsh

[SpecFusion](https://github.com/wxkingstar/SpecFusion) 的 **DeepSeek Harness 插件**：开箱即用地在 DSH 里搜索 20 个中国开放平台的 65,000+ 篇 API 开发文档。

安装后，DSH 会得到一个可被模型自动调用的 skill `specfusion`，以及 5 个**原生工具**（无需 Bash + curl）：

| 工具 | 用途 |
|------|------|
| `specfusion_search` | 搜索文档（接口名 / API 路径 / 错误码 / 功能概念） |
| `specfusion_doc` | 获取文档全文或结构化摘要 |
| `specfusion_sources` | 列出所有已接入平台及文档数 |
| `specfusion_categories` | 浏览文档分类 |
| `specfusion_recent` | 查看近期更新 |

覆盖平台：企业微信、飞书、钉钉、淘宝开放平台、小红书、抖音电商、微信小程序、微信小店、拼多多、有赞、微信支付、支付宝、京东商家、SHEIN、得物、火山引擎、阿里云百炼、泛微 e-teams、北森 iTalent。

## 安装

```bash
dsh plugin --profile web add @wxkingstar/specfusion-dsh
```

从本地源码安装（开发调试）：

```bash
dsh plugin --profile web add file:/absolute/path/to/SpecFusion/dsh-plugin
```

安装后重启 profile（`dsh web`）即可生效。

## 配置

默认使用公共云端服务 `https://specfusion.inagora.org/api`，通常无需配置。

如需指向自部署实例，二选一：

1. 环境变量：

   ```bash
   export SPECFUSION_BASE_URL="http://your-host:3456/api"
   ```

2. 在 profile 的 `cordis.patch.yml` 里覆盖：

   ```yaml
   - id: specfusion-dsh
     baseUrl: "http://your-host:3456/api"
   ```

## 使用

直接提问即可，模型会按需加载 skill 并调用工具：

```
> 企业微信怎么发应用消息？
> 飞书如何创建审批实例？
> 微信支付 JSAPI 下单接口怎么调？
> 淘宝商品发布接口参数有哪些？
```

也可显式调用 skill：`/specfusion 企业微信发送应用消息`。

## 开发

```bash
cd dsh-plugin
npm install
node smoke-test.mjs   # 冒烟测试：校验模块可加载、apply 可注册 skill 与工具
```

本插件为纯 ESM JavaScript，无构建步骤；`lib/` 即发布产物。

## License

[MIT](../LICENSE)
