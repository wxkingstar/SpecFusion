// 同步后清理残留文档：删除本地 DB 中存在、但远程目录已不存在的文档。
//
// 适用场景：官方文档「路径重组」（如目录改名、产品并入其它树）后，sync 只增不删，
// 旧路径会和新路径并存成重复/失效条目。本工具拉取远程最新目录，删除本地多余路径。
//
// 用法（需先 npm run dev 起本地 API）：
//   npx tsx scrapers/prune-source.mts <source>            # dry-run，仅报告待删数量
//   npx tsx scrapers/prune-source.mts <source> --apply    # 真实删除
//
// 安全建议：先 dry-run 核对待删数量与 `cli.ts diff <source>` 的 removed 吻合，再 --apply。
import { createHash } from 'node:crypto';
import { createSource } from './src/sync.js';

const API = process.env.SPECFUSION_API_URL || 'http://localhost:3456/api';
const TOKEN = process.env.ADMIN_TOKEN || 'dev-token';
const source = process.argv[2];
const apply = process.argv.includes('--apply');
if (!source) {
  console.error('用法: npx tsx scrapers/prune-source.mts <source> [--apply]');
  process.exit(2);
}

// 与 api/src/services/doc-store.ts 的 makeDocId 保持一致
const makeDocId = (s: string, p: string) =>
  `${s}_${createHash('sha256').update(p).digest('hex').slice(0, 12)}`;

console.log(`[prune] ${source}: 拉取远程目录...`);
const src = createSource(source);
const entries = await src.fetchCatalog();
const remote = new Set(entries.map((e) => e.path));
console.log(`[prune] 远程 ${remote.size} 篇`);

const resp = await fetch(`${API}/admin/source-paths/${source}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const localPaths: string[] = await resp.json();
console.log(`[prune] 本地 ${localPaths.length} 篇`);

const removed = localPaths.filter((p) => !remote.has(p));

// 远程目录抓取失败/被限流时可能返回空或严重缺失，此时删除会清空整个源。
// 远程数量不足本地一半视为目录异常，拒绝执行。
// 例外：源整体换了路径结构（如 2026-09 京东改版，旧路径全部作废）时本地会是远程的两倍左右。
// 此时先离线核对待删集合，再用 --expect-removed <N> 显式确认数量；实际待删数与 N 不一致仍然中止。
const expectIdx = process.argv.indexOf('--expect-removed');
const expectRemoved = expectIdx > 0 ? Number(process.argv[expectIdx + 1]) : NaN;
// 显式给了 --expect-removed 时无论比例如何都必须严格一致：dry-run 到 --apply 之间目录若变了
// （抓取不全、站点又改版），宁可中止重新核对，也不按一份没核对过的集合删除。
if (expectIdx > 0 && expectRemoved !== removed.length) {
  console.error(`[prune] ✗ 待删数 ${removed.length} 与 --expect-removed ${process.argv[expectIdx + 1]} 不一致，中止。请重新 dry-run 核对`);
  process.exit(1);
}
if (localPaths.length > 0 && remote.size < localPaths.length * 0.5) {
  if (!Number.isInteger(expectRemoved) || expectRemoved !== removed.length) {
    console.error(
      `[prune] ✗ 远程目录数量异常 (${remote.size} < 本地 ${localPaths.length} 的 50%)，疑似目录抓取失败，中止。` +
        `（若确认是整体路径迁移，核对后以 --expect-removed ${removed.length} 显式确认）`
    );
    process.exit(1);
  }
  console.log(`[prune] 远程不足本地 50%，但待删数与 --expect-removed ${expectRemoved} 一致，继续`);
}

console.log(`[prune] 待删除残留 ${removed.length} 篇 (${apply ? '真实删除' : 'DRY-RUN'})`);
removed.slice(0, 10).forEach((p) => console.log('   - ' + p));
if (removed.length > 10) console.log(`   ... 及其余 ${removed.length - 10} 篇`);

if (apply && removed.length > 0) {
  let ok = 0;
  let fail = 0;
  for (const p of removed) {
    const id = makeDocId(source, p);
    try {
      const r = await fetch(`${API}/admin/doc/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (r.ok) ok++;
      else fail++;
    } catch {
      fail++;
    }
  }
  console.log(`[prune] 删除完成: 成功 ${ok}, 失败 ${fail}`);
}

if (typeof (src as { close?: () => Promise<void> }).close === 'function') {
  await (src as { close: () => Promise<void> }).close();
}
process.exit(0);
