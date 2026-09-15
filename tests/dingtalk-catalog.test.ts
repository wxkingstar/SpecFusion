import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDingtalkCatalog,
  type DocCenterNode,
  type DocCenterTabTree,
} from '../scrapers/src/sources/dingtalk.js';

// 钉钉目录来自文档中心接口（getDocPageGroupList → getDocInfoList），
// doc id = sha256(source + path)，路径一旦漂移，sync 后旧路径会残留成重复文档。
// 这里把路径规则钉死：历史 Tab 前缀不变，其余 Tab 用「分组/Tab」。

const tab = (groupName: string, tabName: string, nodes: DocCenterNode[]): DocCenterTabTree => ({
  tab: { groupCode: 'g', groupName, tabCode: `${groupName}-${tabName}`, tabName },
  nodes,
});

const doc = (docName: string, slug: string, section = 'development', children?: DocCenterNode[]): DocCenterNode => ({
  docId: slug,
  docName,
  docType: 1,
  docUrl: `https://open.dingtalk.com/document/${section}/${slug}`,
  children,
});

const dir = (docName: string, children: DocCenterNode[]): DocCenterNode => ({
  docId: docName,
  docName,
  docType: 0,
  children,
});

test('服务端 API / 客户端 JSAPI 沿用历史路径前缀，保证 doc id 不变', () => {
  const entries = buildDingtalkCatalog([
    tab('应用开发', '服务端 API', [dir('API 调用指南', [doc('API 调用步骤详解', 'server-api-calling-guide')])]),
    tab('应用开发', '客户端 JSAPI', [dir('历史文档（不推荐）', [doc('JSAPI总览', 'jsapi-overview')])]),
  ]);

  assert.deepEqual(
    entries.map((e) => e.path),
    ['企业内部应用/API 调用指南/API 调用步骤详解', '客户端JSAPI/历史文档（不推荐）/JSAPI总览'],
  );
  assert.equal(entries[0].title, 'API 调用步骤详解');
  assert.equal(entries[0].sourceUrl, 'https://open.dingtalk.com/document/development/server-api-calling-guide');
  assert.equal(entries[0].platformId, 'server-api-calling-guide');
});

test('其余 Tab 用「分组/Tab」作前缀，名称首尾空白去掉', () => {
  const entries = buildDingtalkCatalog([
    tab('连接平台', '平台介绍', [doc('集成方案', 'integration-scheme', 'connection')]),
    tab('专属版客户端插件', ' Windows 插件', [doc(' 插件概述 ', 'windows-plugin')]),
  ]);

  assert.deepEqual(
    entries.map((e) => e.path),
    ['连接平台/平台介绍/集成方案', '专属版客户端插件/Windows 插件/插件概述'],
  );
  assert.equal(entries[1].title, '插件概述');
});

test('同一 docUrl 出现在多个 Tab 时只收录一次，保留层级更深的路径', () => {
  const entries = buildDingtalkCatalog([
    tab('应用开发', '开发指南', [doc('应用类型', 'app-types', 'dingstart')]),
    tab('工作台', '使用教程', [dir('入门', [doc('应用类型', 'app-types', 'dingstart')])]),
  ]);

  assert.deepEqual(entries.map((e) => e.path), ['工作台/使用教程/入门/应用类型']);
});

test('同 Tab 内不同文档路径相同时，后出现者追加 slug，避免 doc id 撞车互相覆盖', () => {
  const entries = buildDingtalkCatalog([
    tab('应用开发', '事件订阅', [
      dir('OA审批', [doc('审批实例状态变更', 'approval-instance-change'), doc('审批实例状态变更', 'approval-instance-change-v2')]),
    ]),
  ]);

  assert.deepEqual(
    entries.map((e) => e.path),
    ['应用开发/事件订阅/OA审批/审批实例状态变更', '应用开发/事件订阅/OA审批/审批实例状态变更 (approval-instance-change-v2)'],
  );
});

test('带 docUrl 的节点同时有子节点时，自身与子节点都收录', () => {
  const entries = buildDingtalkCatalog([
    tab('应用开发', '服务端 API', [doc('通讯录概述', 'contacts-overview', 'development', [doc('获取用户详情', 'query-user-details')])]),
  ]);

  assert.deepEqual(
    entries.map((e) => e.path),
    ['企业内部应用/通讯录概述', '企业内部应用/通讯录概述/获取用户详情'],
  );
});

test('相对 docUrl 补全为绝对地址', () => {
  const entries = buildDingtalkCatalog([
    tab('应用开发', '钉钉 CLI', [{ docId: 'x', docName: 'CLI 简介', docType: 1, docUrl: '/document/development/cli-intro' }]),
  ]);

  assert.equal(entries[0].sourceUrl, 'https://open.dingtalk.com/document/development/cli-intro');
  assert.equal(entries[0].platformId, 'cli-intro');
});
