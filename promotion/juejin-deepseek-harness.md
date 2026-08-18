# DeepSeek Harness 4 天 13 万 Star，我给它接入了 65,602 篇中国开放平台 API 文档

> 摘要：DeepSeek Harness 的口号是 “Everything is a Plugin”。与其再做一个换主题、加按钮的演示插件，我更想验证：插件能不能真正消掉 AI 编程中的一段重复劳动？于是我把 SpecFusion 接入了 DSH——一个插件，直接搜索 20 个中国开放平台的 65,602 篇 API 文档。

8 月 13 日，DeepSeek 开源了 DeepSeek Harness（`dsh`）的 Developer Preview。到写这篇文章时，官方仓库已经超过 12.9 万 Star。

热度当然有 DeepSeek 的品牌因素，但它最值得关注的并不是“又一个 AI 编程客户端”，而是那句非常激进的架构口号：**Everything is a Plugin**。

模型、工具、Skill、会话、文件系统、沙箱、Agent Loop，甚至 UI 都是插件。也就是说，DSH 更像一个可组合的 Agent 运行时，而不是功能已经焊死的产品。

我最近一直在维护 SpecFusion：一个给 AI Agent 用的中国开放平台 API 文档检索服务。看到 DSH 发布后，我做的第一件事，就是把它适配成原生插件。

## AI 会写代码，但它未必拿得到正确的国内 API 文档

在接企业微信、飞书、钉钉、淘宝、抖音电商、微信支付、支付宝、京东这些平台时，真正消耗时间的经常不是写请求，而是找文档：

- 文档分散在 20 个完全不同的网站里；
- 有些页面依赖登录、SPA 渲染或多层目录；
- 中文接口名、英文 API 路径、错误码混在一起，站内搜索不一定好用；
- Agent 知道“应该调用某个接口”，但训练数据里的参数可能已经过期。

传统工作流是：AI 写到一半，人去浏览器翻文档，复制参数回来，再让 AI 继续。Agent 没有真正闭环。

SpecFusion 做的事情很窄：把这些官方文档抓取、清洗、建立全文索引，再通过只读 API 交给 Agent 搜索。当前线上实际数据是 **20 个平台、65,602 篇文档**。

它支持按四类信息搜索：

- 接口名：`发送应用消息`
- API 路径：`/cgi-bin/message/send`
- 错误码：`40001`、`60011`
- 功能概念：`客户联系`、`JSAPI 下单`

中文检索采用 jieba 预分词 + SQLite FTS5；我从当前网络实测了三组查询，端到端大约在 0.1～0.4 秒之间。

## 接入 DSH 后，不只是“能加载一个 Skill”

SpecFusion 的 DSH 插件会注册一个运行时 Skill，以及 5 个原生工具：

| 工具 | 用途 |
| --- | --- |
| `specfusion_search` | 按接口名、路径、错误码或概念搜索 |
| `specfusion_doc` | 获取一篇文档全文或结构化摘要 |
| `specfusion_sources` | 查看平台和文档数量 |
| `specfusion_categories` | 按平台浏览文档分类 |
| `specfusion_recent` | 查看近期新增或更新的文档 |

这里的关键差异是：**模型不需要通过 Bash 拼 `curl` 命令**。工具在 DSH 的 Tool Registry 里有明确的参数 Schema、返回类型和用途说明，模型可以直接发现并调用。

典型链路会是这样：

1. 你问：“微信支付 JSAPI 下单接口怎么调？”
2. DSH 自动加载 `specfusion` Skill。
3. 模型调用 `specfusion_search` 找到正确接口。
4. 再调用 `specfusion_doc` 读取参数、请求示例和注意事项。
5. 模型基于检索到的官方文档继续写代码。

插件本身保持只读、无状态、并发安全。它不需要你的开放平台密钥，也不会代替你调用支付、订单或消息接口；它只负责把参考文档交给模型。

## 安装只要一条命令

先启动 DeepSeek Harness：

```bash
npx @deepseek-ai/dsh web
```

然后给 `web` profile 安装 SpecFusion：

```bash
dsh plugin --profile web add @wxkingstar/specfusion-dsh
```

重启 `dsh web` 后，直接提问即可：

```text
企业微信怎么发应用消息？
飞书如何创建审批实例？
淘宝商品发布接口参数有哪些？
微信支付 JSAPI 下单接口怎么调？
```

默认使用已经部署好的公共检索服务，不需要再装数据库或爬虫。如果有合规或内网要求，也可以用 Docker / Kubernetes 自部署，插件通过 `SPECFUSION_BASE_URL` 指向自己的实例。

## 为什么是“插件 + 云端检索”，而不是把 6 万篇文档塞进包里

SpecFusion 的前身曾经走过本地 MCP Server 的路线：把大量文档、爬虫依赖和搜索服务一起装到用户机器上。实际体验并不好——包体积大、依赖多、安装和升级成本都高。

现在的分工更清晰：

- 云端负责同步官方文档和全文索引；
- DSH 插件负责暴露稳定的原生工具；
- Skill 负责告诉模型何时搜索、如何缩小范围、如何引用结果。

用户侧只安装一个很薄的插件，数据更新也不需要重新发包。对于“搜索 → 取全文 → 继续写代码”这类只读场景，这种形态更轻。

## 开发者预览阶段，兼容性要说在前面

DeepSeek 官方明确提示：DSH 目前仍是 Developer Preview，后续会有 Breaking Changes。SpecFusion 插件当前版本是 `0.1.1`，适配现有的 DSH Skill / Tools 接口；如果上游接口变化，我会继续跟进。

这也是现在开放源码的价值：插件注册、Schema、客户端和 profile patch 都在仓库里，遇到兼容问题可以直接定位，而不是把用户困在一个黑盒里。

## 最后

我认为 “Everything is a Plugin” 真正有意思的地方，不是能把界面改得多花，而是能把开发者反复切换、查找、复制的工作，变成 Agent 可以稳定调用的能力。

SpecFusion 现在覆盖企业微信、飞书、钉钉、淘宝、小红书、抖音电商、微信小程序、微信小店、拼多多、有赞、微信支付、支付宝、京东、SHEIN、得物、火山引擎、阿里云百炼、泛微 e-teams、北森 iTalent 等 20 个平台。

项目 MIT 开源。如果它正好解决了你的问题，欢迎在 GitHub 点一个 Star；也欢迎提 Issue 告诉我你最希望补哪个平台或哪类文档。

- SpecFusion：https://github.com/wxkingstar/SpecFusion
- 在线搜索：https://specfusion.kingstar.xin
- npm 插件：https://www.npmjs.com/package/@wxkingstar/specfusion-dsh
- DeepSeek Harness：https://github.com/deepseek-ai/deepseek-harness

