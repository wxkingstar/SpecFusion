/**
 * ego-lite 浏览器适配层。
 *
 * 把 `scripts/ego-bridge.mjs` 暴露的 HTTP 接口包装成 Playwright 风格的
 * Page 对象，让各文档源不再自己 `chromium.launch()`，而是复用 ego lite
 * 的浏览器（带用户登录态、真实浏览器指纹，反爬站点更不容易被拦）。
 *
 * 只实现各源实际用到的子集：goto / waitForSelector / evaluate / click /
 * on('response') / off('response')。
 *
 * 桥接地址通过 EGO_BRIDGE_URL 指定，默认 http://127.0.0.1:39222。
 */
import { delay } from './pace.js';

const BRIDGE_URL = process.env.EGO_BRIDGE_URL || 'http://127.0.0.1:39222';

/** 响应事件轮询间隔（ms） */
const DRAIN_INTERVAL = 150;

/** 桥接不可达时的重连尝试次数与间隔（ego lite 会不定期回收 Node 运行时） */
const RECONNECT_ATTEMPTS = 30;
const RECONNECT_INTERVAL = 5_000;

async function callBridge<T>(
  route: string,
  body: unknown = {},
  { retry = true }: { retry?: boolean } = {},
): Promise<T> {
  // 连接层失败（桥接进程正在被看护脚本重启）要等它回来，而不是把
  // 剩下几千篇文档全部判成失败 —— 曾因此让 jd 一次跑出 5,456 个错误。
  const attempts = retry ? RECONNECT_ATTEMPTS : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(`${BRIDGE_URL}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastErr = error;
      if (attempts === 1) break;
      if (attempt === 0) {
        console.warn(`[ego] 桥接不可达，等待重连（最多 ${(RECONNECT_ATTEMPTS * RECONNECT_INTERVAL) / 1000}s）...`);
      }
      await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL));
      continue;
    }

    const data = (await resp.json()) as T & { error?: string };
    // 业务级错误（选择器没等到之类）照常抛给调用方，不重试
    if (!resp.ok || data?.error) {
      throw new Error(`[ego] ${route} 失败: ${data?.error ?? resp.status}`);
    }
    if (attempt > 0) console.log('[ego] 桥接已恢复');
    return data;
  }
  throw new Error(
    `[ego] ${route} 失败: 桥接持续不可达（${BRIDGE_URL}）: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** 桥接是否可用（启动前的探测，不做重连等待） */
export async function egoBridgeReady(): Promise<boolean> {
  try {
    await callBridge('health', {}, { retry: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Playwright 的 `text=xxx` 选择器 ego 不认，翻译成 xpath。
 * 其余选择器（CSS / xpath= / @N / loc=）原样透传。
 */
function translateSelector(selector: string): string {
  const m = /^text=(.+)$/.exec(selector);
  if (!m) return selector;
  const text = m[1].replace(/"/g, '\\"');
  return `xpath=//*[normalize-space(text())="${text}"]`;
}

/** Playwright Response 的最小兼容对象 */
export interface EgoResponse {
  url(): string;
  status(): number;
  text(): Promise<string>;
  /** 与 Playwright 一致返回 any，调用方按各站点的响应结构自行断言 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
}

type ResponseHandler = (response: EgoResponse) => void | Promise<void>;

/**
 * Playwright Page 的最小兼容实现，后端是 ego lite。
 *
 * 网络响应拦截的语义与 Playwright 略有差异：桥接只缓存 URL 命中
 * `capturePatterns` 的响应。因此调用 `on('response', ...)` 前需要先
 * `setCapturePatterns([...])` 告诉桥接关心哪些接口。
 */
export class EgoPage {
  private handlers = new Set<ResponseHandler>();
  private draining = false;

  /** 声明需要拦截的 URL 片段；不调用则不会收到任何 response 事件 */
  async setCapturePatterns(patterns: string[]): Promise<void> {
    await callBridge('capture/start', { patterns });
  }

  async goto(
    url: string,
    opts: { waitUntil?: string; timeout?: number } = {},
  ): Promise<void> {
    // Playwright 的 timeout 是毫秒，ego 是秒
    const timeout = Math.ceil((opts.timeout ?? 30_000) / 1000);
    await callBridge('goto', { url, timeout });
  }

  /**
   * `state` 为兼容 Playwright 调用方而保留：ego 的 waitForElement 只判断
   * 元素是否出现，不区分 attached / visible，这里接受但忽略该选项。
   */
  async waitForSelector(
    selector: string,
    opts: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' } = {},
  ): Promise<void> {
    const timeout = Math.ceil((opts.timeout ?? 20_000) / 1000);
    await callBridge('waitForSelector', {
      selector: translateSelector(selector),
      timeout,
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { value } = await callBridge<{ value: T }>('evaluate', { expression });
    return value;
  }

  async click(selector: string, _opts: { timeout?: number } = {}): Promise<void> {
    await callBridge('click', { selector: translateSelector(selector) });
  }

  /** 页面上下文内发请求（带 cookie），用于替代拦截 XHR 的场景 */
  async fetchInPage(url: string, options?: RequestInit): Promise<string> {
    const { body } = await callBridge<{ body: string }>('fetch', { url, options });
    return body;
  }

  on(event: 'response', handler: ResponseHandler): void {
    if (event !== 'response') return;
    const wasIdle = this.handlers.size === 0;
    this.handlers.add(handler);
    if (!this.draining) void this.startDraining(wasIdle);
  }

  off(event: 'response', handler: ResponseHandler): void {
    if (event !== 'response') return;
    this.handlers.delete(handler);
  }

  /**
   * @param flushStale 从「无监听」转为「有监听」时先丢弃桥接里已缓存的响应。
   *
   * 桥接一直在后台缓存 XHR，而 Playwright 的语义是「注册监听之后的响应才会
   * 收到」。不丢弃的话，上一篇文档残留的响应会立刻投递给新 handler —— dewu
   * 这类「匹配任意 doc 响应」的源会把上一篇的内容当成这一篇，静默写错数据。
   */
  private async startDraining(flushStale = false): Promise<void> {
    this.draining = true;
    if (flushStale) {
      await callBridge('capture/drain').catch(() => {});
    }
    while (this.handlers.size > 0) {
      try {
        const { responses } = await callBridge<{
          responses: Array<{ url: string; status: number; body: string | null }>;
        }>('capture/drain');

        for (const r of responses) {
          const resp: EgoResponse = {
            url: () => r.url,
            status: () => r.status,
            text: async () => r.body ?? '',
            json: async () => JSON.parse(r.body ?? 'null'),
          };
          for (const h of this.handlers) {
            try {
              await h(resp);
            } catch {
              /* 单个 handler 抛错不影响其他 */
            }
          }
        }
      } catch {
        /* 桥接暂时不可用，下一轮重试 */
      }
      await delay(DRAIN_INTERVAL);
    }
    this.draining = false;
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await callBridge('capture/stop').catch(() => {});
  }
}

// ── axios 兼容的 HTTP 客户端 ───────────────────────────────────────────────

// 与 axios 对齐：默认 any，让调用方保持原有的 response.data?.xxx 写法
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface EgoHttpResponse<T = any> {
  data: T;
  status: number;
}

/**
 * 以 ego lite 页面上下文为传输层的 HTTP 客户端，接口对齐 axios 的
 * `get` / `post` 子集。
 *
 * 相比 axios + cookie 文件的好处：请求由真实浏览器页面发出，自带完整
 * cookie、正确的 Referer 和浏览器指纹，反爬站点（如企业微信的 500003
 * 人机验证）不容易触发。
 */
export class EgoHttpClient {
  constructor(private baseURL: string) {}

  /** 让页面先落到目标站点，后续请求才带上同源 cookie 与 Referer */
  async warmup(url: string, timeout = 40): Promise<void> {
    await callBridge('goto', { url, timeout });
  }

  private async request<T>(
    url: string,
    options: Record<string, unknown>,
  ): Promise<EgoHttpResponse<T>> {
    const full = url.startsWith('http') ? url : `${this.baseURL}${url}`;
    const { body } = await callBridge<{ body: string }>('fetch', { url: full, options });
    // axios 会自动解析 JSON，这里对齐：能解析就给对象，否则原样返回文本
    let data: unknown = body;
    try {
      data = JSON.parse(body);
    } catch {
      /* 非 JSON（如文档页 HTML），保持字符串 */
    }
    return { data: data as T, status: 200 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get<T = any>(
    url: string,
    config: { headers?: Record<string, string> } = {},
  ): Promise<EgoHttpResponse<T>> {
    return this.request<T>(url, { method: 'GET', headers: config.headers });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async post<T = any>(
    url: string,
    body: unknown,
    config: { headers?: Record<string, string> } = {},
  ): Promise<EgoHttpResponse<T>> {
    return this.request<T>(url, {
      method: 'POST',
      headers: config.headers,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
  }
}

/** 创建 ego 支撑的 HTTP 客户端；桥接未启动时抛错 */
export async function createEgoHttpClient(baseURL: string): Promise<EgoHttpClient> {
  if (!(await egoBridgeReady())) {
    throw new Error(
      `[ego] 桥接服务未运行（${BRIDGE_URL}）。请先启动：\n` +
        `  scripts/ego-bridge.sh`,
    );
  }
  return new EgoHttpClient(baseURL);
}

/** 获取一个 ego 支撑的 Page；桥接未启动时抛错并给出启动命令 */
export async function createEgoPage(): Promise<EgoPage> {
  if (!(await egoBridgeReady())) {
    throw new Error(
      `[ego] 桥接服务未运行（${BRIDGE_URL}）。请先启动：\n` +
        `  ego-browser nodejs < scripts/ego-bridge.mjs`,
    );
  }
  return new EgoPage();
}
