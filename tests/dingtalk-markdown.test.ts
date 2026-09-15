import { test } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToMarkdown } from '../scrapers/src/sources/dingtalk.js';

// 钉钉正文来自浏览器渲染后的 DOM：代码块是 Monaco 编辑器（带行号栏、重命名浮层），
// 标题里有 SDK 版本标签，摘要段里有「AI 智能摘要」入口和更新时间。
// extractPageContent 会在页面里把代码块换成 Monaco model 的源码并去掉这些 UI，
// 这里钉住 htmlToMarkdown 这一层：文本安全插入、代码缩进保留、兜底清理。

test('代码块按纯文本插入：<?php 不被当成 HTML 吞掉后续内容，缩进与连续空格保留', () => {
  const md = htmlToMarkdown(
    '<pre><code class="language-php">&lt;?php\n    echo "a    b";\n</code></pre><p>之后的段落</p>',
    'T',
  );

  assert.ok(md.includes('```php\n<?php\n    echo "a    b";\n'), md);
  assert.ok(md.includes('```\n之后的段落'), md);
});

test('表格单元格与行内代码里的尖括号保留', () => {
  const md = htmlToMarkdown(
    '<table><tr><th>类型</th></tr><tr><td>List&lt;String&gt;</td></tr></table><p>行内 <code>Map&lt;K,V&gt;</code> 结束</p>',
    'T',
  );

  assert.ok(md.includes('| List<String> |'), md);
  assert.ok(md.includes('行内 `Map<K,V>` 结束'), md);
});

test('代码块之外的多余空白与空行仍被压缩', () => {
  const md = htmlToMarkdown('<p>a     b</p>\n\n\n\n<p>c</p>', 'T');

  assert.equal(md, '# T\n\na b\n\nc');
});

test('未替换的 Monaco 编辑器按可视行（按 top 排序）还原，去掉行号栏、重命名浮层与按钮', () => {
  const editor =
    '<div class="doc-code-block dark"><section><div data-mode-id="plaintext">' +
    '<div class="monaco-editor vs-dark" data-uri="inmemory://model/9"><div class="overflow-guard">' +
    '<div class="margin"><div class="margin-view-overlays">' +
    '<div style="position:absolute;top:0px;"><div class="active-line-number line-numbers">1</div></div>' +
    '<div style="position:absolute;top:24px;"><div class="line-numbers">2</div></div>' +
    '<div style="position:absolute;top:48px;"><div class="line-numbers">3</div></div>' +
    '</div></div>' +
    '<div class="monaco-scrollable-element"><div class="lines-content"><div class="view-lines">' +
    '<div style="top:24px;height:24px;" class="view-line"><span><span>&nbsp;&nbsp;"a":&nbsp;1</span></span></div>' +
    '<div style="top:48px;height:24px;" class="view-line"><span><span>}</span></span></div>' +
    '<div style="top:0px;height:24px;" class="view-line"><span><span>{</span></span></div>' +
    '</div></div></div>' +
    '<div class="overflowingContentWidgets"><div class="monaco-editor rename-box">' +
    '<input class="rename-input"><div class="rename-label">Enter to Rename, ⇧Enter to Preview</div></div></div>' +
    '</div></div></div></section>' +
    '<div class="doc-code-copy">复制</div><div class="doc-code-mode-change">切换主题</div></div>';

  const md = htmlToMarkdown(`<p>请求示例</p>${editor}<p>结束</p>`, 'T');

  assert.ok(md.includes('```\n{\n  "a": 1\n}\n```'), md);
  assert.ok(!md.includes('Enter to Rename'), md);
  assert.ok(!/复制|切换主题/.test(md), md);
  assert.ok(md.includes('结束'), md);
});

test('残留的 AI 智能摘要入口、更新时间与 SDK 版本标签被去掉，摘要正文保留', () => {
  const md = htmlToMarkdown(
    '<p class="shortdesc"><span class="gmtModify"><span class="ai-summary-entry-wrapper"><span class="ai-summary-entry">' +
      '<img src="https://gw.alicdn.com/x.png" alt="AI 智能摘要" class="ai-summary-text"></span></span>更新于 2026-06-04</span>' +
      '<span>调用本接口获取文件信息。</span></p>' +
      '<h2>标题<span class="doc-h1-version doc-h1-version-POP">新版SDK</span></h2>',
    'T',
  );

  assert.ok(md.includes('调用本接口获取文件信息。'), md);
  assert.ok(!md.includes('AI 智能摘要'), md);
  assert.ok(!md.includes('更新于'), md);
  assert.ok(md.endsWith('## 标题'), md);
  assert.ok(!md.includes('新版SDK'), md);
});

test('表格单元格里的代码块转成单行行内代码，不在表格行里塞代码围栏', () => {
  const md = htmlToMarkdown(
    '<table><tr><th>类型</th><th>属性</th></tr>' +
      '<tr><td>人员</td><td><pre><code>{\n  multiple: boolean; // 支持多选\n}</code></pre></td></tr></table>',
    'T',
  );

  assert.ok(md.includes('| 人员 | `{ multiple: boolean; // 支持多选 }` |'), md);
  assert.ok(!md.includes('```'), md);
});
