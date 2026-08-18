import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase, upsertDocument, getDb } from "./doc-store.js";
import { tokenize } from "./tokenizer.js";
import { search } from "./search-engine.js";

let tmpDir: string;

// 索引端写入 tokenized_* 的方式与 scraper 完全一致：普通模式 jieba 切分
function addDoc(path: string, title: string, content: string): void {
  upsertDocument({
    source_id: "test",
    path,
    title,
    content,
    tokenized_title: tokenize(title),
    tokenized_content: tokenize(content),
  });
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "specfusion-test-"));
  initDatabase(join(tmpDir, "test.db"));

  addDoc("/a", "获取企业下的自定义空间", "调用该接口获取企业下的自定义空间列表。");
  addDoc("/b", "通讯录展示组件", "通讯录展示组件用于在页面中展示成员信息。");
  addDoc("/c", "管理网络研讨会暖场配置", "管理网络研讨会的暖场配置项。");
  addDoc("/d", "获取部门列表", "调用该接口获取部门列表。");
  addDoc("/e", "订单详情查询", "查询订单详情。");
});

after(() => {
  getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 回归：中文复合词必须能搜到（查询端与索引端分词不一致会导致 0 条）
// ---------------------------------------------------------------------------

for (const query of [
  "自定义",
  "通讯录展示组件",
  "管理网络研讨会暖场配置",
  "获取企业下的自定义空间",
]) {
  test(`中文复合词「${query}」能搜到结果`, () => {
    const { totalCount } = search({ query });
    assert.ok(totalCount > 0, `期望 > 0 条，实际 ${totalCount} 条`);
  });
}

// ---------------------------------------------------------------------------
// 精度：token 之间是 AND，不应因为放宽召回而命中无关文档
// ---------------------------------------------------------------------------

test("查询「自定义」不应命中无关文档", () => {
  const { results } = search({ query: "自定义", limit: 20 });
  const titles = results.map((r) => r.title);
  assert.ok(!titles.includes("订单详情查询"), `不应命中：${titles.join(", ")}`);
  assert.ok(!titles.includes("获取部门列表"), `不应命中：${titles.join(", ")}`);
});

test("多词查询各 token 之间为 AND", () => {
  const { results } = search({ query: "获取部门列表", limit: 20 });
  assert.deepEqual(
    results.map((r) => r.title),
    ["获取部门列表"],
  );
});

// ---------------------------------------------------------------------------
// 总数：「共 N 条」必须是真实总数，不能被候选集上限或 limit 截断
// ---------------------------------------------------------------------------

test('关键词搜索的总数不被候选集上限（200）截断', () => {
  for (let i = 0; i < 250; i++) {
    addDoc(`/bulk/${i}`, `zzitem${i}`, `zzbulktoken content ${i}`);
  }

  const { results, totalCount } = search({ query: 'zzbulktoken', limit: 5 });

  assert.equal(results.length, 5);
  assert.equal(totalCount, 250);
});

test('关键词搜索的总数按 title+api_path 去重后统计', () => {
  for (let i = 0; i < 3; i++) {
    upsertDocument({
      source_id: 'test',
      path: `/dup/${i}`,
      title: 'zzduptitle',
      api_path: '/zz/dup',
      content: 'zzduptoken content',
      tokenized_title: tokenize('zzduptitle'),
      tokenized_content: tokenize('zzduptoken content'),
    });
  }

  const { totalCount } = search({ query: 'zzduptoken', limit: 5 });

  assert.equal(totalCount, 1);
});

test('指定 mode 时不去重，总数为原始命中数', () => {
  for (const devMode of ['server', 'client', 'web']) {
    upsertDocument({
      source_id: 'test',
      path: `/mode/${devMode}`,
      title: 'zzmodetitle',
      api_path: '/zz/mode',
      dev_mode: devMode,
      content: 'zzmodetoken content',
      tokenized_title: tokenize('zzmodetitle'),
      tokenized_content: tokenize('zzmodetoken content'),
    });
  }

  assert.equal(search({ query: 'zzmodetoken', limit: 5 }).totalCount, 1);
  assert.equal(search({ query: 'zzmodetoken', mode: 'server', limit: 5 }).totalCount, 1);
});

test('API 路径搜索的总数不被 limit 截断', () => {
  for (let i = 0; i < 10; i++) {
    upsertDocument({
      source_id: 'test',
      path: `/apipath/${i}`,
      title: `zzpath${i}`,
      api_path: `/cgi-bin/zzprobe/${i}`,
      content: 'api path fixture',
      tokenized_title: tokenize(`zzpath${i}`),
      tokenized_content: tokenize('api path fixture'),
    });
  }

  const { results, totalCount } = search({ query: '/cgi-bin/zzprobe', limit: 3 });

  assert.equal(results.length, 3);
  assert.equal(totalCount, 10);
});

// ---------------------------------------------------------------------------
// 排序：候选集必须是全局最相关的那一批，而不是 rowid 最小的那一批
// ---------------------------------------------------------------------------

test('最相关的文档即使排在候选集上限之外也能进入结果', () => {
  // 先塞 250 篇弱相关文档（命中词被大量无关内容稀释），占满候选集上限
  for (let i = 0; i < 250; i++) {
    const filler = `alpha bravo charlie delta echo foxtrot golf hotel india juliet ${i}`;
    addDoc(`/rank/filler/${i}`, `zzfiller${i}`, `${filler} zzranktoken ${filler}`);
  }

  // 强相关文档最后插入，rowid 排在 250 篇之后
  addDoc('/rank/target', 'zzranktoken', 'zzranktoken');

  const { results } = search({ query: 'zzranktoken', limit: 5 });

  assert.equal(results[0].title, 'zzranktoken');
});
