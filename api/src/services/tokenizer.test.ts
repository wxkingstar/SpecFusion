import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from './tokenizer.js';

// 查询端与索引端共用 tokenize()，切分必须保持「不产生重叠子词」的性质：
// 一旦切出索引里不存在的子词（如把「自定义」切成「自定 定义 自定义」），
// FTS5 的隐式 AND 会让查询恒为 0 条。
test('中文复合词保持完整，不切出重叠子词', () => {
  assert.equal(tokenize('自定义'), '自定义');
  assert.equal(tokenize('通讯录展示组件'), '通讯录 展示 组件');
  assert.equal(tokenize('发送应用消息'), '发送 应用消息');
});

test('受保护片段原样保留', () => {
  assert.equal(tokenize('access_token'), 'access_token');
  assert.equal(tokenize('/cgi-bin/message/send'), '/cgi-bin/message/send');
});

test('停用词被过滤', () => {
  assert.equal(tokenize('获取企业下的自定义空间'), '获取 企业 下 自定义 空间');
});
