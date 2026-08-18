/**
 * ego-lite 浏览器桥接服务。
 *
 * 以 `ego-browser nodejs < scripts/ego-bridge.mjs` 启动，在 ego lite 的
 * Node 运行时里常驻一个本地 HTTP 服务，把 ego 的浏览器能力暴露成
 * Playwright 风格的接口，供 scrapers 里的各文档源调用。
 *
 * 这样抓取全程走 ego lite（复用用户登录态、真实浏览器指纹），
 * 不再由 scraper 自己 launch Playwright chromium。
 *
 * 端口通过环境变量 EGO_BRIDGE_PORT 指定，默认 39222。
 *
 * 接口（全部 POST，body 为 JSON）：
 *   /goto            {url, waitUntil, timeout}      → 导航
 *   /waitForSelector {selector, timeout}            → 等待元素
 *   /evaluate        {expression}                   → 页面内求值
 *   /click           {selector, timeout}            → 点击
 *   /snapshot        {}                             → 语义快照
 *   /fetch           {url, options}                 → 页面上下文发请求（带 cookie）
 *   /capture/start   {patterns:[string]}            → 开始缓存匹配的 XHR 响应
 *   /capture/drain   {}                             → 取出并清空已捕获响应
 *   /capture/stop    {}                             → 停止捕获
 *   /health          {}                             → 存活探测
 */

const http = await import('node:http');

// ego 运行时不继承父进程环境变量，端口/任务空间由 scripts/ego-bridge.sh
// 在管道里做占位符替换；直接运行本文件则使用下面的默认值。
const PORT = Number('__PORT__') || 39222;
const TASK_SPACE = '__TASK_SPACE__'.startsWith('__') ? 'specfusion 文档抓取' : '__TASK_SPACE__';

const task = await useOrCreateTaskSpace(TASK_SPACE);
cliLog(`[bridge] task space: ${task.id} (${TASK_SPACE})`);

// ── 网络响应捕获 ──────────────────────────────────────────────────────────
//
// drainEvents() 是消费式的，所以这里跑一个常驻轮询：把 Network.responseReceived
// 里 URL 命中 patterns 的响应连同 body 一起缓存下来，供 /capture/drain 取走。

let capturePatterns = [];
let captured = [];
let capturing = false;
let pollTimer = null;

/**
 * responseReceived 只代表响应头到了，此时 getResponseBody 可能拿不到或
 * 只拿到半截（京东那种几百 KB 的接口尤其明显）。所以先在 responseReceived
 * 记下 requestId，等 loadingFinished 再取 body。
 */
const pending = new Map();

async function pollEvents() {
  if (!capturing) return;
  try {
    const raw = await drainEvents();
    const events = Array.isArray(raw) ? raw : raw?.events || [];

    for (const ev of events) {
      if (ev?.method === 'Network.responseReceived') {
        // 只关心接口调用，滤掉文档/脚本/图片等资源，避免拉取大量无用 body
        const type = ev.params?.type;
        if (type !== 'XHR' && type !== 'Fetch') continue;
        const url = ev.params?.response?.url || '';
        // patterns 为空表示捕获全部 XHR，由调用方自己筛选
        if (capturePatterns.length && !capturePatterns.some((p) => url.includes(p))) continue;
        pending.set(ev.params.requestId, {
          url,
          status: ev.params?.response?.status ?? 0,
        });
        continue;
      }

      if (ev?.method === 'Network.loadingFinished' || ev?.method === 'Network.loadingFailed') {
        const meta = pending.get(ev.params?.requestId);
        if (!meta) continue;
        pending.delete(ev.params.requestId);
        if (ev.method === 'Network.loadingFailed') continue;

        let body = null;
        try {
          const r = await cdp('Network.getResponseBody', { requestId: ev.params.requestId });
          body = r?.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r?.body;
        } catch {
          // body 已被回收，只能放弃这一条
        }
        captured.push({ ...meta, body });
      }
    }
  } catch {
    // 轮询失败不致命，下一轮继续
  }
  if (capturing) pollTimer = setTimeout(pollEvents, 60);
}

// ── 各接口实现 ────────────────────────────────────────────────────────────

const handlers = {
  async health() {
    const info = await pageInfo().catch(() => ({}));
    return { ok: true, taskId: task.id, url: info?.url ?? null };
  },

  // 抓取要在同一个标签里翻上千个页面。openOrReuseTab 对每个新 URL 都会
  // 新开标签，用它做爬取会瞬间堆出几千个标签页拖垮浏览器；因此只在没有
  // 可用标签时开一次，之后一律用 gotoAndWait 在当前标签内导航。
  async goto({ url, timeout = 30, settle }) {
    if (!(await ensureRealTab())) {
      await openOrReuseTab(url, { wait: true, timeout });
    } else {
      await gotoAndWait(url, { timeout, settle });
    }
    const info = await pageInfo();
    return { url: info.url, title: info.title };
  },

  async tabs() {
    const list = await listTabs();
    return { count: list.length, tabs: list.slice(0, 20) };
  },

  /** 关掉多余标签，只留一个用于抓取 */
  async 'tabs/prune'() {
    const list = await listTabs();
    let closed = 0;
    for (const t of list.slice(1)) {
      await closeTab(t.targetId ?? t.id ?? t).catch(() => {});
      closed++;
    }
    return { closed, remaining: (await listTabs()).length };
  },

  async waitForSelector({ selector, timeout = 20 }) {
    await waitForElement(selector, { timeout });
    return { found: true };
  },

  async evaluate({ expression }) {
    return { value: await js(expression) };
  },

  async click({ selector, label }) {
    await click(selector, label ? { label } : undefined);
    return { clicked: true };
  },

  async snapshot() {
    return { text: await snapshotText() };
  },

  async fetch({ url, options }) {
    const body = await browserFetch(url, options);
    return { body: typeof body === 'string' ? body : JSON.stringify(body) };
  },

  async 'capture/start'({ patterns }) {
    capturePatterns = Array.isArray(patterns) ? patterns : [patterns];
    captured = [];
    if (!capturing) {
      capturing = true;
      await cdp('Network.enable', {}).catch(() => {});
      pollEvents();
    }
    return { capturing: true, patterns: capturePatterns };
  },

  async 'capture/drain'() {
    const out = captured;
    captured = [];
    return { responses: out };
  },

  async shutdown() {
    // 落一个标记，让 ego-bridge.sh 的看护循环知道这是主动停止、别再拉起
    try {
      const fsm = await import('node:fs');
      fsm.writeFileSync(`/tmp/ego-bridge-${PORT}.stop`, '');
    } catch {
      /* 标记写不了也不影响退出 */
    }
    setTimeout(() => process.exit(0), 50);
    return { shutdown: true };
  },

  async 'capture/stop'() {
    capturing = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    captured = [];
    capturePatterns = [];
    pending.clear();
    return { capturing: false };
  },
};

// ── HTTP 服务 ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const route = req.url.replace(/^\/+|\/+$/g, '').split('?')[0];
  const handler = handlers[route];

  const send = (code, payload) => {
    const buf = Buffer.from(JSON.stringify(payload));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
    res.end(buf);
  };

  if (!handler) return send(404, { error: `未知接口: ${route}` });

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return send(400, { error: `请求体不是合法 JSON: ${e.message}` });
      }
    }
    try {
      send(200, await handler(body));
    } catch (e) {
      send(500, { error: e?.message || String(e) });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  cliLog(`[bridge] listening on http://127.0.0.1:${PORT}`);
});

// 常驻：ego 运行时在脚本 resolve 后退出，这里永不 resolve
await new Promise(() => {});
