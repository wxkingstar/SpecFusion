/**
 * SpecFusion 云端 API 的轻量 HTTP 客户端。
 *
 * SpecFusion 的公开 API 全部返回 `text/markdown`（非 JSON），因此客户端只做
 * 拼 URL、转发 AbortSignal 和把非 2xx 转成可读错误，返回原始文本给工具层。
 *
 * @module @wxkingstar/specfusion-dsh/client
 */

/** 默认云端服务地址（HTTPS）。 */
export const DEFAULT_BASE_URL = "https://specfusion.inagora.org/api";

/** 环境变量，允许自部署用户不改配置直接覆盖 base URL。 */
export const BASE_URL_ENV = "SPECFUSION_BASE_URL";

const USER_AGENT = "specfusion-dsh/0.1.0";

/**
 * 创建一个绑定到指定 base URL 的客户端。
 * @param {string} [baseUrl] 形如 `http://host:3456/api`，默认使用公共云端服务。
 */
export function createClient(baseUrl = DEFAULT_BASE_URL) {
  const base = String(baseUrl).replace(/\/+$/, "");
  return {
    /** 客户端使用的 base URL（去尾斜杠）。 */
    baseUrl: base,
    /**
     * GET 一个 API 路径并返回 Markdown 文本。
     * @param {string} path 以 `/` 开头的路径（如 `/search`、`/doc/{id}`）。
     * @param {Record<string, unknown>} [params] 查询参数；undefined/null/空串会被跳过。
     * @param {AbortSignal} [signal] 调用方的取消信号，转发给 fetch。
     * @returns {Promise<string>} 响应正文（Markdown）。
     */
    async get(path, params = {}, signal) {
      const url = new URL(base + path);
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }

      let response;
      try {
        response = await fetch(url, {
          signal,
          headers: {
            accept: "text/markdown, text/plain;q=0.9, */*;q=0.8",
            "user-agent": USER_AGENT,
          },
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new Error(`specfusion: 请求已取消 (${url.pathname})`);
        }
        throw new Error(`specfusion: 请求失败 ${url.pathname}: ${errorMessage(error)}`);
      }

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()).slice(0, 200);
        } catch {
          // 读取失败时保留空 detail。
        }
        throw new Error(
          `specfusion: HTTP ${response.status} for ${url.pathname}` +
            (detail ? `: ${detail}` : ""),
        );
      }

      return await response.text();
    },
  };
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
