# DeepSeek Harness 的 “Everything is a Plugin” 到底能做什么？我把 6.5 万篇国内 API 文档接了进去

8 月 13 日，DeepSeek Harness 以 Developer Preview 的形式开源。4 天左右，官方仓库已经超过 12.9 万 Star。

我觉得这波热度里最值得讨论的，不是“DeepSeek 也做了一个 Claude Code”，而是它对 Harness 的定义：**Everything is a Plugin**。模型、工具、Skill、会话、沙箱、文件系统、Agent Loop 和 UI 都可以被组合或替换。

但架构理念最终要落到一个问题上：它能不能帮开发者少做一点真实、重复、容易出错的工作？

我用自己维护的开源项目 SpecFusion 做了一个实验：把 20 个中国开放平台的 65,602 篇 API 文档接进 DSH，让 Agent 在写代码时直接检索接口名、路径、参数和错误码。

## Agent 编程的一个隐蔽瓶颈：不是不会写，而是上下文拿不准

今天的大模型写一个 HTTP 请求并不难。难的是它依据哪一版文档、用的是哪种应用模式、参数是否已经变化。

这个问题在国内开放平台尤其明显。企业微信、飞书、钉钉、淘宝、抖音电商、微信支付、支付宝、京东等平台各有一套文档系统：有的需要登录，有的是 SPA，有的目录层级很深，有的站内搜索对中文、API 路径和错误码并不友好。

所以常见场景是：Agent 已经在终端里工作，人却要中断它，打开浏览器找文档，再把参数复制回来。这意味着工作流实际上没有闭环。

SpecFusion 的定位很克制：它不是另一个通用搜索引擎，而是一个面向 Agent 的中国开放平台 API 文档索引。当前线上数据共 65,602 篇，搜索支持接口名、API 路径、错误码和功能概念，返回适合模型直接阅读的 Markdown。

## 为什么我觉得它适合做成 DSH 插件

如果只是放一个搜索网站，最终仍然需要人来搬运上下文；如果只写一个很长的 Skill，模型知道“应该搜索”，但仍需要通过 Bash 和 `curl` 绕一层调用。

DSH 插件可以同时提供两样东西：

1. **Skill**：告诉模型什么场景应该查文档、如何缩小平台范围、如何引用结果；
2. **原生工具**：给搜索、取全文、列平台、浏览分类、查看更新提供明确的参数 Schema。

SpecFusion 插件因此注册了 5 个只读工具：`specfusion_search`、`specfusion_doc`、`specfusion_sources`、`specfusion_categories` 和 `specfusion_recent`。

用户问“微信支付 JSAPI 下单接口怎么调”时，理想链路不是模型凭记忆直接回答，而是先搜到当前接口，再读文档摘要或全文，最后基于结果生成代码。

这也是我理解的 Harness 价值：**模型能力之外，把信息、工具和执行边界组织好。**

## 这套设计刻意没有做什么

插件不会读取你的支付、订单或企业账号密钥，也不会替你调用业务接口。它只访问公开的静态参考文档，工具只读、无状态，并发安全。

默认有公共云端索引，是为了让安装尽量轻；如果团队有内网或合规要求，整个服务也可以用 Docker / Kubernetes 自部署，再让插件指向私有地址。

这背后还有一个取舍：不把 6 万多篇文档打包进 npm。把数据放在云端，官方文档更新后只需要刷新索引，用户不必重新安装一个越来越大的包。

## 怎么安装

DeepSeek Harness 本身可以这样启动：

```bash
npx @deepseek-ai/dsh web
```

给 `web` profile 安装 SpecFusion 插件：

```bash
dsh plugin --profile web add @wxkingstar/specfusion-dsh
```

重启后直接问即可，例如：

```text
企业微信怎么发应用消息？
飞书如何创建审批实例？
淘宝商品发布接口参数有哪些？
微信支付 JSAPI 下单接口怎么调？
```

## 我对 DeepSeek Harness 现阶段的判断

12 万多 Star 不等于产品已经成熟。官方也明确写着目前是 Developer Preview，会出现 Breaking Changes。对普通用户来说，DSH 现在可能仍然比成熟的一体化编程 Agent 更折腾。

但对插件作者和 Agent 基础设施开发者，它的吸引力确实很强：插件不是附着在产品外围的“小挂件”，而是构成运行时本身的基本单元。

这给了社区一个很大的实验空间。接下来真正值得看的，不只是又出现多少插件，而是能否出现一批把真实工作流产品化的插件：文档检索、企业系统集成、可观测性、权限边界、长期记忆、垂直领域工具等。

SpecFusion 是我在这个方向上的一次小尝试。项目 MIT 开源，当前覆盖企业微信、飞书、钉钉、淘宝、小红书、抖音电商、微信支付、支付宝、京东、火山引擎、阿里云百炼等 20 个平台。

如果你也经常被国内开放平台文档折磨，欢迎试用；觉得有价值的话，也欢迎去 GitHub 点个 Star。更欢迎提 Issue 告诉我：下一个最该补的平台是什么。

- GitHub：https://github.com/wxkingstar/SpecFusion
- 在线搜索：https://specfusion.kingstar.xin
- DSH 插件：https://www.npmjs.com/package/@wxkingstar/specfusion-dsh
- DeepSeek Harness 官方仓库：https://github.com/deepseek-ai/deepseek-harness

