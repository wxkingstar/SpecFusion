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
