/**
 * 拼多多文档数据刷新脚本（在 ego lite 运行时里跑）。
 *
 *   bash scripts/pdd-refresh.sh
 *
 * 拼多多的文档接口在 open-api.pinduoduo.com，要 POST + 登录态 +
 * `Anti-Content`（页面 JS 每次现算的反爬令牌），脚本无法自己构造。
 * 所以这里不直接调接口，而是**驱动页面导航、捕获它自己发出的响应**：
 *
 *   - /pop/doc/category/list   页面加载时触发 → 全部分类
 *   - /pop/doc/info/list/byCat 导航到某个 API 时触发 → 该分类的 API 列表
 *   - /pop/doc/info/get        导航到某个 API 时触发 → 该 API 详情
 *
 * 分类列表需要展开侧边栏才能点，比较脆；改用「每个分类挑一个已知 API 当
 * 种子导航」的方式触发 byCat，拿到各分类的完整列表（含新增 API）。
 *
 * 产物写回 scrapers/data/pdd_api_docs.json，格式与原先浏览器手动导出的
 * 完全一致，因此 scrapers/src/sources/pinduoduo.ts 的解析逻辑无需改动。
 */

const fs = await import('node:fs');

const JSON_PATH = '__JSON_PATH__';
const DOC_URL = (id) =>
  `https://open.pinduoduo.com/application/document/api?id=${encodeURIComponent(id)}`;

const task = await useOrCreateTaskSpace('specfusion 拼多多登录');
cliLog(`[pdd] task space ${task.id}`);

await cdp('Network.enable', {});

// ── 响应捕获 ──────────────────────────────────────────────────────────────

/**
 * 排干事件队列，把 /pop/doc/ 下的响应体按接口名归类返回。
 * body 必须等 loadingFinished 才能取，responseReceived 时取会拿到空值。
 */
async function drainDocResponses() {
  const out = {};
  const pending = new Map();
  const raw = await drainEvents();
  const events = Array.isArray(raw) ? raw : raw?.events || [];

  for (const ev of events) {
    if (ev?.method === 'Network.responseReceived') {
      const url = ev.params?.response?.url || '';
      if (/\/pop\/doc\//.test(url)) pending.set(ev.params.requestId, url);
      continue;
    }
    if (ev?.method === 'Network.loadingFinished' && pending.has(ev.params?.requestId)) {
      const url = pending.get(ev.params.requestId);
      pending.delete(ev.params.requestId);
      try {
        const r = await cdp('Network.getResponseBody', { requestId: ev.params.requestId });
        const body = r?.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r?.body;
        const key = url.split('/pop/doc/')[1].split('?')[0];
        const parsed = JSON.parse(body);
        if (parsed?.result !== undefined) (out[key] ||= []).push(parsed.result);
      } catch {
        // preflight / body 已回收，跳过
      }
    }
  }
  return out;
}

/** 导航到某个 API 页并收集触发的接口响应 */
async function visit(apiId, settle = 3) {
  await drainDocResponses(); // 清掉上一轮残留
  await gotoAndWait(DOC_URL(apiId), { timeout: 40 });
  await wait(settle);
  return drainDocResponses();
}

// ── 1. 读旧数据当种子 ─────────────────────────────────────────────────────

const old = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
cliLog(`[pdd] 旧数据: ${old.categories.length} 分类 / ${old.apiList.length} API（导出于 ${old.exportedAt}）`);

const seedByCat = new Map();
for (const item of old.apiList) {
  if (!seedByCat.has(item._catId)) seedByCat.set(item._catId, item.scopeName);
}

// ── 2. 首屏拿全部分类 ─────────────────────────────────────────────────────

const first = await visit(old.apiList[0].scopeName, 6);
const categories = (first['category/list'] || []).flat();
if (!categories.length) {
  cliLog('[pdd] ✗ 未捕获到分类列表，可能登录态失效');
  throw new Error('category/list 未捕获到');
}
cliLog(`[pdd] 分类: ${categories.length} 个`);

const catMap = {};
for (const c of categories) catMap[String(c.id ?? c.catId)] = c.name ?? c.catName;

// ── 3. 每个分类挑种子导航，拿完整 API 列表 ───────────────────────────────

const apiList = [];
const seen = new Set();

function collectDocList(resp, catId, catName) {
  for (const r of resp['info/list/byCat'] || []) {
    for (const d of r?.docList || []) {
      if (!d?.scopeName || seen.has(d.scopeName)) continue;
      seen.add(d.scopeName);
      apiList.push({ ...d, _catId: catId, _catName: catName });
    }
  }
}

collectDocList(first, old.apiList[0]._catId, old.apiList[0]._catName);

const missingSeed = [];
for (const c of categories) {
  const catId = c.id ?? c.catId;
  const catName = c.name ?? c.catName;
  const seed = seedByCat.get(catId);
  if (!seed) {
    missingSeed.push(`${catName}(${catId})`);
    continue;
  }
  const resp = await visit(seed);
  collectDocList(resp, catId, catName);
  cliLog(`[pdd] 分类 ${catName}: 累计 ${apiList.length} 个 API`);
}
if (missingSeed.length) {
  cliLog(`[pdd] ⚠ 以下分类没有旧种子，其 API 可能未收录: ${missingSeed.join(', ')}`);
}

// ── 4. 逐个抓详情 ─────────────────────────────────────────────────────────

const details = [];
let done = 0;
let failed = 0;
for (const api of apiList) {
  const resp = await visit(api.scopeName, 2);
  const detail = (resp['info/get'] || []).find((d) => d?.scopeName === api.scopeName);
  if (detail) {
    details.push({ ...detail, _catId: api._catId, _catName: api._catName });
  } else {
    failed++;
  }
  if (++done % 25 === 0) cliLog(`[pdd] 详情进度 ${done}/${apiList.length}（失败 ${failed}）`);
}

// ── 5. 写回 JSON ──────────────────────────────────────────────────────────

const dump = {
  categories,
  catMap,
  apiList,
  details,
  exportedAt: new Date().toISOString(),
};
// 与浏览器导出的原格式保持一致：压缩成一行。
// 缩进输出会让这个 5.5MB 的文件变成 8.5MB / 24 万行，纯属空白噪音。
fs.writeFileSync(JSON_PATH, JSON.stringify(dump));

cliLog(`[pdd] ✓ 完成: ${categories.length} 分类 / ${apiList.length} API / ${details.length} 详情（失败 ${failed}）`);
cliLog(`[pdd] 已写入 ${JSON_PATH}`);
