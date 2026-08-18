I built a native DeepSeek Harness plugin for [SpecFusion](https://github.com/wxkingstar/SpecFusion), a full-text index of **65,602 official API docs across 20 Chinese open platforms**.

It targets a common problem when coding integrations for WeCom, Feishu, DingTalk, Taobao, Douyin E-commerce, WeChat Pay, Alipay, JD, SHEIN, Volcengine, and others: the model can write the request, but the current endpoint, parameters, and error codes are scattered across inconsistent and sometimes login-gated documentation sites.

The plugin registers one runtime skill and five native, read-only tools:

- `specfusion_search` — search by API name, endpoint path, error code, or concept
- `specfusion_doc` — fetch a full document or a structured summary
- `specfusion_sources` — list sources and document counts
- `specfusion_categories` — browse categories
- `specfusion_recent` — inspect recently updated docs

Install it into the web profile:

```bash
dsh plugin --profile web add @wxkingstar/specfusion-dsh
```

Restart `dsh web`, then ask questions such as “How do I send an application message with WeCom?” or “Which parameters does WeChat Pay JSAPI ordering require?” The model can search first, fetch the relevant document, and continue coding from retrieved context instead of relying on memory.

The tools are stateless and read-only. No platform credentials are required. A hosted index works by default, and the API can also be self-hosted with Docker/Kubernetes.

- [GitHub (MIT)](https://github.com/wxkingstar/SpecFusion)
- [npm package](https://www.npmjs.com/package/@wxkingstar/specfusion-dsh)
- [Live search](https://specfusion.kingstar.xin)

Feedback and requests for additional platforms are very welcome.
