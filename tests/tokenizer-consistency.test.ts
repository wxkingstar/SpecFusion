import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize as apiTokenize } from '../api/src/services/tokenizer.js';
import { tokenize as scraperTokenize } from '../scrapers/src/utils/tokenizer.js';

// 索引端（scrapers 写 tokenized_title / tokenized_content）和查询端（api 拼
// FTS5 MATCH 表达式）是两份独立的 tokenizer 实现。FTS5 里空格是隐式 AND，
// 两端切分一旦分歧，查询就会切出索引中不存在的 token，整条查询恒为 0 条。
// 这里把一致性钉死，防止再次漂移。
const SAMPLES = [
  '自定义',
  '空间',
  '通讯录展示组件',
  '管理网络研讨会暖场配置',
  '获取企业下的自定义空间',
  '发送应用消息',
  '获取access_token',
  '调用该接口可以向指定的用户发送应用消息',
  '/cgi-bin/message/send',
  'contact:user.base:readonly',
  '错误码 40001 说明',
];

for (const sample of SAMPLES) {
  test(`索引端与查询端对「${sample}」分词一致`, () => {
    assert.equal(apiTokenize(sample), scraperTokenize(sample));
  });
}
