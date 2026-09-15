import { load } from 'cheerio';
import type { DocSource, DocEntry, DocContent } from '../types.js';
import { delay } from '../utils/pace.js';
import { createEgoPage, type EgoPage } from '../utils/ego-page.js';

/** 浏览器页面类型 — 由 ego lite 提供，接口与 Playwright Page 的常用子集一致 */
type Page = EgoPage;

// ── 常量 ──────────────────────────────────────────────────────────────────────

const DINGTALK_BASE = 'https://open.dingtalk.com';

/**
 * 文档中心接口（公开、免登录）。文档站侧边栏的导航树就是它渲染的：
 * getDocPageGroupList 返回「分组 → Tab」，getDocInfoList?tabCode= 返回该 Tab 的
 * 完整目录树（文档节点带 docUrl）。
 *
 * 不要改用 /document/orgapp|isvapp/* 页面上那棵导航树（React treeData 无 docUrl）：
 * 它是 icms 的 DITA map（OSS 上的 <section>/meta.json），只在页面不属于任何 Tab 时
 * 由前端回退渲染。orgapp/isvapp 两棵 map 自 2025-09 起不再更新，与文档中心大量
 * 同文异 slug，收录只会引入过时的重复文档。
 */
const DOC_CENTER_API = `${DINGTALK_BASE}/api/docCenter`;

/** 目录接口单次请求超时（ms）与重试次数 */
const CATALOG_TIMEOUT = 30_000;
const CATALOG_RETRIES = 3;

/** 每次导航间隔（ms），避免触发风控 */
const NAV_DELAY = 300;

/** 页面加载超时（ms） */
const PAGE_TIMEOUT = 30_000;

/** 内容选择器等待超时（ms） */
const SELECTOR_TIMEOUT = 15_000;

/** 等待代码块 Monaco 编辑器挂载：轮询次数与间隔（ms），最多约 5 秒 */
const CODE_EDITOR_POLLS = 20;
const CODE_EDITOR_POLL_INTERVAL = 250;

/**
 * 历史 Tab 的路径前缀。doc id = sha256(source + path)，前缀一改所有文档 id 都会变，
 * 所以改版前就收录的两个 Tab 沿用当年按种子页起的名字（「企业内部应用」实为服务端 API）。
 * 键为「分组名/去掉空白的 Tab 名」；其余 Tab 以「分组名/Tab 名」为前缀。
 */
const LEGACY_TAB_PREFIX: Record<string, string> = {
  '应用开发/服务端API': '企业内部应用',
  '应用开发/客户端JSAPI': '客户端JSAPI',
};

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface DocCenterTab {
  groupCode: string;
  groupName: string;
  tabCode: string;
  tabName: string;
}

/** getDocInfoList 的目录节点：docType 0 为目录，1 为文档（带 docUrl） */
export interface DocCenterNode {
  docId: string;
  docName: string;
  docType: number;
  docUrl?: string;
  children?: DocCenterNode[];
}

export interface DocCenterTabTree {
  tab: DocCenterTab;
  nodes: DocCenterNode[];
}

interface DocCenterGroup {
  groupCode: string;
  groupName: string;
  tabs?: Array<{ tabCode: string; tabName: string }>;
}

// ── DingtalkSource ────────────────────────────────────────────────────────────

/**
 * 钉钉开放平台文档源适配器
 *
 * 目录直接请求文档中心接口；正文仍需浏览器渲染（JSAPI 参数表、应用类型等由页面
 * 运行时填充，OSS 上的原始 topic HTML 里只有占位符），经 ego lite 逐页导航提取
 * HTML 再转换为 Markdown。
 */
export class DingtalkSource implements DocSource {
  id = 'dingtalk';
  name = '钉钉';

  private page: Page | null = null;
  private dialogsDismissed = false;

  // ── 浏览器生命周期 ──────────────────────────────────────────────────────

  private async ensureBrowser(): Promise<Page> {
    if (!this.page) {
      this.page = await createEgoPage();
    }
    return this.page;
  }

  /** 释放页面资源（同步结束后调用） */
  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
  }

  // ── fetchCatalog ────────────────────────────────────────────────────────

  /**
   * 任一 Tab 拉取失败都直接抛错，绝不返回残缺目录：prune 会把目录里没有的本地
   * 文档当作残留删除，残缺目录就等于误删。
   */
  async fetchCatalog(): Promise<DocEntry[]> {
    const groups = await this.getDocCenter<DocCenterGroup>('getDocPageGroupList');
    const tabs: DocCenterTab[] = groups.flatMap((g) =>
      (g.tabs ?? []).map((t) => ({
        groupCode: g.groupCode,
        groupName: g.groupName,
        tabCode: t.tabCode,
        tabName: t.tabName,
      })),
    );

    // 找不到历史 Tab 说明分组或 Tab 改了名，继续跑会让上千篇文档整体换路径
    const legacyPrefixes = new Set(Object.values(LEGACY_TAB_PREFIX));
    const foundPrefixes = new Set(tabs.map(tabPathPrefix));
    const missing = [...legacyPrefixes].filter((p) => !foundPrefixes.has(p));
    if (missing.length > 0) {
      throw new Error(
        `[dingtalk] 文档中心找不到历史 Tab（${missing.join('、')}），分组或 Tab 可能已改名，请先核对 LEGACY_TAB_PREFIX`,
      );
    }

    const trees: DocCenterTabTree[] = [];
    for (const tab of tabs) {
      const nodes = await this.getDocCenter<DocCenterNode>(
        `getDocInfoList?tabCode=${encodeURIComponent(tab.tabCode)}`,
      );
      const prefix = tabPathPrefix(tab);
      const count = countDocs(nodes);
      console.log(`[dingtalk]   ${prefix}: ${count} 篇文档`);
      if (count === 0 && legacyPrefixes.has(prefix)) {
        throw new Error(`[dingtalk] 历史 Tab「${prefix}」返回 0 篇文档，疑似接口异常，中止`);
      }
      trees.push({ tab, nodes });
      await delay(NAV_DELAY);
    }

    const entries = buildDingtalkCatalog(trees);
    console.log(
      `[dingtalk] 目录提取完成，${tabs.length} 个 Tab，共 ${entries.length} 篇文档（去重后）`,
    );
    return entries;
  }

  // ── fetchContent ────────────────────────────────────────────────────────

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const page = await this.ensureBrowser();
    const url = entry.sourceUrl;

    if (!url) {
      throw new Error(`[dingtalk] 文档缺少 sourceUrl: ${entry.title}`);
    }

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT,
      });
    } catch (err) {
      // 导航错误（如 ERR_TOO_MANY_REDIRECTS）会把 page 留在 chrome-error://chromewebdata/，
      // 下一次 goto 会被这个残留导航打断。重置到 about:blank 让后续请求有干净起点。
      await page.goto('about:blank').catch(() => {});
      throw err;
    }

    await this.dismissDialogs(page);

    // 等待文档内容区域加载（不依赖 networkidle，直接等选择器）
    await page.waitForSelector('.icms-help-docs-content', {
      timeout: SELECTOR_TIMEOUT,
    });
    await this.waitForCodeEditors(page);

    const raw = await this.extractPageContent(page);
    if ('error' in raw) {
      throw new Error(
        `[dingtalk] 内容提取失败 (${entry.title}): ${raw.error}`,
      );
    }

    // 用提取到的更新日期丰富 entry
    if (raw.lastUpdated) {
      entry.lastUpdated = raw.lastUpdated;
    }

    const markdown = htmlToMarkdown(raw.fullHtml, raw.title || entry.title);
    const apiPath = extractApiPath(markdown);
    const errorCodes = extractErrorCodes(markdown);

    await delay(NAV_DELAY);

    // 标题里的「新版SDK / 旧版SDK」标签已从正文标题去掉，保留在元信息里
    const metadata: Record<string, unknown> = {};
    if (raw.lastUpdated) metadata.last_updated = raw.lastUpdated;
    if (raw.sdkVersion) metadata.sdk_version = raw.sdkVersion;

    return {
      markdown,
      apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  // ── detectUpdates ───────────────────────────────────────────────────────

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    // 简单实现：返回全量目录，由 sync 层通过内容对比判断实际变更
    return this.fetchCatalog();
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────

  /** 关闭钉钉页面可能出现的引导弹窗（仅首次导航时尝试） */
  private async dismissDialogs(page: Page): Promise<void> {
    if (this.dialogsDismissed) return;
    for (const text of ['我知道了', '好的，知道了', '知道了']) {
      try {
        await page.click(`text=${text}`, { timeout: 2000 });
      } catch {
        /* 无弹窗，继续 */
      }
    }
    this.dialogsDismissed = true;
  }

  /** 请求文档中心接口并返回 result 数组；网络或业务错误按退避重试，最终失败抛错 */
  private async getDocCenter<T>(endpoint: string): Promise<T[]> {
    let lastError = '';
    for (let attempt = 1; attempt <= CATALOG_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${DOC_CENTER_API}/${endpoint}`, {
          headers: { Accept: 'application/json', Referer: `${DINGTALK_BASE}/document/` },
          signal: AbortSignal.timeout(CATALOG_TIMEOUT),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const body = (await resp.json()) as { success?: boolean; result?: unknown };
        if (!body.success || !Array.isArray(body.result)) {
          throw new Error(`接口返回异常: ${JSON.stringify(body).slice(0, 200)}`);
        }
        return body.result as T[];
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < CATALOG_RETRIES) await delay(2000 * attempt);
      }
    }
    throw new Error(
      `[dingtalk] 文档中心接口 ${endpoint} 请求失败（已重试 ${CATALOG_RETRIES} 次）: ${lastError}`,
    );
  }

  /**
   * 等代码块的 Monaco 编辑器挂载完成。未挂载时读不到 model，只能按可视行兜底。
   * 超时不报错，按当前 DOM 提取。
   */
  private async waitForCodeEditors(page: Page): Promise<void> {
    for (let i = 0; i < CODE_EDITOR_POLLS; i++) {
      const ready = await page.evaluate<boolean>(`(() => {
        const blocks = [...document.querySelectorAll('.icms-help-docs-content main .doc-code-block')];
        const models = window.monaco && window.monaco.editor ? window.monaco.editor.getModels().length : 0;
        return blocks.every((b) => b.querySelector('.monaco-editor[data-uri]')) && models >= blocks.length;
      })()`);
      if (ready) return;
      await delay(CODE_EDITOR_POLL_INTERVAL);
    }
  }

  /**
   * 从文档页 DOM 提取标题、更新日期、SDK 版本和正文 HTML。
   *
   * 正文取整个 main（conbody 之外还有摘要段、示例代码 section；无 conbody 的指南页正文在
   * div.body），在克隆上清掉页面 UI：
   * - 代码块是 Monaco 编辑器，DOM 里只有带行号的可视行：长代码被虚拟滚动截断，未选中的
   *   语言 tab 只渲染 1 行，还混着「Enter to Rename」浮层。完整源码从 window.monaco 的
   *   model 读取（编辑器的 data-uri 即 model uri），换成 <pre><code>
   * - 多语言示例只保留默认选中的 tab，与页面默认展示一致
   * - 去掉 h1（标题由 htmlToMarkdown 统一加）、摘要段里的 AI 摘要入口与更新时间
   */
  private async extractPageContent(
    page: Page,
  ): Promise<
    | { title: string; lastUpdated: string; sdkVersion: string; fullHtml: string }
    | { error: string }
  > {
    return page.evaluate(`(() => {
      const container = document.querySelector('.icms-help-docs-content');
      if (!container) return { error: 'icms-help-docs-content not found' };

      const main = container.querySelector('main');
      if (!main) return { error: 'main element not found' };

      // 标题里嵌着「新版SDK / 旧版SDK」标签
      const h1 = main.querySelector('h1');
      let title = '';
      let sdkVersion = '';
      if (h1) {
        const heading = h1.cloneNode(true);
        heading.querySelectorAll('.doc-h1-version').forEach((el) => {
          sdkVersion = el.textContent.trim();
          el.remove();
        });
        title = heading.textContent.trim();
      }

      const shortdesc = main.querySelector('.shortdesc');
      const dateMatch = shortdesc
        ? shortdesc.textContent.match(/更新于\\s*(\\d{4}-\\d{2}-\\d{2})/)
        : null;
      const lastUpdated = dateMatch ? dateMatch[1] : '';

      // 克隆前从活动 DOM 读取：代码源码（克隆节点没有 model）与 tab 选中状态
      const models = window.monaco && window.monaco.editor ? window.monaco.editor.getModels() : [];
      const sources = [...main.querySelectorAll('.doc-code-block')].map((block) => {
        const editor = block.querySelector('.monaco-editor[data-uri]');
        const uri = editor ? editor.getAttribute('data-uri') : '';
        const model = models.find((m) => m.uri.toString() === uri);
        return model ? { code: model.getValue(), lang: model.getLanguageId() } : null;
      });
      const tabChecked = [...main.querySelectorAll('.tabbed-codeblock-box > input')].map((el) => el.checked);

      const body = main.cloneNode(true);

      body.querySelectorAll('.doc-code-block').forEach((block, i) => {
        const source = sources[i];
        if (!source) return; // 没拿到 model 的交给 htmlToMarkdown 按可视行兜底
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (source.lang && source.lang !== 'plaintext') code.className = 'language-' + source.lang;
        code.textContent = source.code;
        pre.appendChild(code);
        block.replaceWith(pre);
      });

      const tabInputs = [...body.querySelectorAll('.tabbed-codeblock-box > input')];
      body.querySelectorAll('.tabbed-codeblock-box').forEach((box) => {
        const items = [...box.children].filter((el) => el.classList.contains('codeblock-item'));
        const anyChecked = [...box.children].some((el) => el.tagName === 'INPUT' && tabChecked[tabInputs.indexOf(el)]);
        let checked = !anyChecked; // 没有任何选中项时保留第一个
        let label = '';
        [...box.children].forEach((child) => {
          if (child.tagName === 'INPUT') {
            checked = anyChecked ? !!tabChecked[tabInputs.indexOf(child)] : child === box.querySelector('input');
          } else if (child.tagName === 'LABEL') {
            label = child.textContent.trim();
          } else if (items.includes(child)) {
            if (!checked) {
              child.remove();
              return;
            }
            const code = child.querySelector('pre > code');
            if (code && !code.className && label) code.className = 'language-' + label.toLowerCase().replace(/[^a-z0-9]/g, '');
          }
        });
        box.querySelectorAll(':scope > input, :scope > label, :scope > .tab-box').forEach((el) => el.remove());
      });

      const titleEl = body.querySelector('h1');
      if (titleEl) titleEl.remove();
      body
        .querySelectorAll('.gmtModify, .ai-summary-entry-wrapper, .doc-code-copy, .doc-code-mode-change')
        .forEach((el) => el.remove());

      return { title, lastUpdated, sdkVersion, fullHtml: body.innerHTML };
    })()`) as any;
  }
}

// ── 目录构建 ──────────────────────────────────────────────────────────────────

/** Tab 的路径前缀：历史 Tab 沿用旧名，其余为「分组名/Tab 名」 */
function tabPathPrefix(tab: DocCenterTab): string {
  const groupName = tab.groupName.trim();
  const legacy = LEGACY_TAB_PREFIX[`${groupName}/${tab.tabName.replace(/\s+/g, '')}`];
  return legacy ?? `${groupName}/${tab.tabName.trim()}`;
}

function countDocs(nodes: DocCenterNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.docUrl ? 1 : 0) + countDocs(n.children ?? []), 0);
}

/** 文档 URL 最后一段即 slug（与 icms 的 topics/<slug>.html 对应） */
function slugOf(url: string): string {
  const { pathname } = new URL(url);
  return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || url;
}

/**
 * 把各 Tab 的目录树展开为 DocEntry。
 * - 以 docUrl 去重：同一文档挂在多处时，保留 Tab 内层级更深（分类更具体）的路径
 * - 不同文档路径相同（同目录下同名）时，后出现者追加 slug，否则 doc id 撞车互相覆盖
 */
export function buildDingtalkCatalog(trees: DocCenterTabTree[]): DocEntry[] {
  const byUrl = new Map<string, { entry: DocEntry; depth: number }>();

  for (const { tab, nodes } of trees) {
    const prefix = tabPathPrefix(tab);
    const walk = (list: DocCenterNode[], parents: string[]) => {
      for (const node of list) {
        const title = node.docName.trim();
        const segments = [...parents, title];
        if (node.docUrl) {
          const sourceUrl = node.docUrl.startsWith('http')
            ? node.docUrl
            : `${DINGTALK_BASE}${node.docUrl.startsWith('/') ? '' : '/'}${node.docUrl}`;
          const tabPath = segments.join('/');
          const existing = byUrl.get(sourceUrl);
          if (!existing || segments.length > existing.depth) {
            byUrl.set(sourceUrl, {
              depth: segments.length,
              entry: {
                path: `${prefix}/${tabPath}`,
                title,
                sourceUrl,
                // 用 Tab 内路径推断，与改版前一致（前缀「客户端JSAPI」会把整棵树误判为 api_reference）
                docType: detectDocType(tabPath, sourceUrl),
                platformId: slugOf(sourceUrl),
              },
            });
          }
        }
        if (node.children?.length) walk(node.children, segments);
      }
    };
    walk(nodes, []);
  }

  const seenPaths = new Set<string>();
  const entries: DocEntry[] = [];
  for (const { entry } of byUrl.values()) {
    if (seenPaths.has(entry.path)) entry.path = `${entry.path} (${entry.platformId})`;
    seenPaths.add(entry.path);
    entries.push(entry);
  }
  return entries;
}

// ── 文档类型推断 ──────────────────────────────────────────────────────────────

function detectDocType(nodePath: string, url: string): string | undefined {
  const lower = (nodePath + ' ' + url).toLowerCase();
  if (
    lower.includes('错误码') ||
    lower.includes('error-code') ||
    lower.includes('errcode')
  ) {
    return 'error_code';
  }
  if (lower.includes('事件') && !lower.includes('概述')) return 'event';
  if (lower.includes('更新日志') || lower.includes('changelog')) {
    return 'changelog';
  }
  if (lower.includes('jsapi')) return 'api_reference';
  if (/\/v\d+\.\d+\//.test(url) || lower.includes('/topapi/')) {
    return 'api_reference';
  }
  return 'guide';
}

// ── HTML → Markdown 转换 ─────────────────────────────────────────────────────

/**
 * 将钉钉文档 HTML 转换为 Markdown。
 *
 * 输入一般是 extractPageContent 清理过的 main（代码块已换成 Monaco model 源码），这里负责：
 * - 生成的 Markdown 片段一律以文本插回 DOM：replaceWith(字符串) 会被当成 HTML 再解析，
 *   `<?php` 会吞掉其后整段正文，`List<String>` 只剩 `List`
 * - 兜底清理页面 UI（AI 摘要入口、更新时间、SDK 版本标签、代码块按钮），并把没替换掉的
 *   Monaco 编辑器按可视行还原（长代码可能被虚拟滚动截断，仅作兜底）
 * - 代码块内保留原始缩进与空行，只压缩代码块之外的空白
 * - 告警框（.icms-help-docs-alert / [class*="note"]）、API 参数表格
 */
export function htmlToMarkdown(html: string, title: string): string {
  const $ = load(html);

  /** 以文本节点插回的 Markdown 片段，最终由 $.text() 原样取出 */
  const asText = (text: string) => $('<span></span>').text(text);
  /** 代码块生成围栏；位于表格单元格内时压成一行行内代码，否则会把表格行撑断 */
  const fence = (code: string, lang: string, inCell: boolean) =>
    inCell
      ? asText('`' + code.replace(/\s+/g, ' ').trim().replace(/`/g, '\\`') + '`')
      : asText(`\n\`\`\`${lang}\n${code.replace(/\n+$/, '')}\n\`\`\`\n`);

  // ── 预处理：移除无用元素 ────────────────────────────────────────────

  $('script, style, .doc-recommend-section').remove();

  // 页面 UI：AI 摘要入口、更新时间、SDK 版本标签、代码块按钮与 tab 头、Monaco 浮层
  $(
    '.ai-summary-entry-wrapper, .gmtModify, .doc-h1-version, .doc-code-copy, .doc-code-mode-change, ' +
      '.tabbed-codeblock-box > input, .tabbed-codeblock-box > label, .tab-box, .overflowingContentWidgets',
  ).remove();

  // 旧版代码块中的行号列
  $('td.code-line-number, td[class*="line-number"]').remove();

  // ── 代码块 ──────────────────────────────────────────────────────────

  // 兜底：没换成 <pre> 的 Monaco 编辑器按可视行 top 排序还原（行号栏在 .margin 里，不取）
  $('.monaco-editor').each((_, el) => {
    const $editor = $(el);
    const lines = $editor
      .find('.view-line')
      .toArray()
      .map((line) => ({
        top: Number(/top:\s*(-?\d+)/.exec($(line).attr('style') ?? '')?.[1] ?? 0),
        text: $(line).text().replace(/ /g, ' '),
      }))
      .sort((a, b) => a.top - b.top)
      .map((line) => line.text);
    const mode = $editor.closest('[data-mode-id]').attr('data-mode-id') ?? '';
    const $block = $editor.closest('.doc-code-block');
    ($block.length ? $block : $editor).replaceWith(
      fence(lines.join('\n'), mode === 'plaintext' ? '' : mode, $editor.closest('td, th').length > 0),
    );
  });

  $('pre').each((_, el) => {
    const $el = $(el);
    const codeEl = $el.find('code');
    const lang = codeEl.attr('class')?.match(/language-(\w+)/)?.[1] || '';
    const text = codeEl.text() || $el.text();
    $el.replaceWith(fence(text, lang, $el.closest('td, th').length > 0));
  });

  // 内联 code
  $('code').each((_, el) => {
    const $el = $(el);
    if ($el.parent().is('pre')) return;
    $el.replaceWith(asText('`' + $el.text().replace(/`/g, '\\`') + '`'));
  });

  // ── 标题 ────────────────────────────────────────────────────────────

  for (let i = 1; i <= 6; i++) {
    $(`h${i}`).each((_, el) => {
      const $el = $(el);
      $el.replaceWith(asText(`\n${'#'.repeat(i)} ${$el.text().trim()}\n`));
    });
  }

  // ── 表格 ────────────────────────────────────────────────────────────

  $('table').each((_, el) => {
    const $table = $(el);
    const rows: string[][] = [];

    $table.find('tr').each((_, tr) => {
      const cells: string[] = [];
      $(tr)
        .find('th, td')
        .each((_, cell) => {
          cells.push($(cell).text().trim().replace(/\n/g, ' '));
        });
      rows.push(cells);
    });

    if (rows.length === 0) return;

    const colCount = Math.max(...rows.map((r) => r.length));
    let md = '\n';
    rows.forEach((row, idx) => {
      const cells = row.map((c) => ` ${c} `);
      while (cells.length < colCount) cells.push('  ');
      md += '|' + cells.join('|') + '|\n';
      if (idx === 0) {
        md += '|' + cells.map(() => '---').join('|') + '|\n';
      }
    });
    md += '\n';
    $table.replaceWith(asText(md));
  });

  // ── 告警 / 提示框（钉钉特有） ──────────────────────────────────────

  $(
    '.icms-help-docs-alert, [class*="note"], [class*="warning"], [class*="important"], [class*="notice"]',
  ).each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(asText(`\n> **注意**: ${text}\n`));
    }
  });

  // ── 链接 ────────────────────────────────────────────────────────────

  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const text = $el.text().trim();
    if (href && text) {
      $el.replaceWith(asText(`[${text}](${href})`));
    } else if (text) {
      $el.replaceWith(asText(text));
    }
  });

  // ── 图片 ────────────────────────────────────────────────────────────

  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    const alt = $el.attr('alt') || '';
    if (src) {
      $el.replaceWith(asText(`![${alt}](${src})`));
    }
  });

  // ── 列表 ────────────────────────────────────────────────────────────

  $('ul').each((_, el) => {
    const $el = $(el);
    let md = '\n';
    $el.find('> li').each((_, li) => {
      md += `- ${$(li).text().trim()}\n`;
    });
    $el.replaceWith(asText(md + '\n'));
  });

  $('ol').each((_, el) => {
    const $el = $(el);
    let md = '\n';
    $el.find('> li').each((i, li) => {
      md += `${i + 1}. ${$(li).text().trim()}\n`;
    });
    $el.replaceWith(asText(md + '\n'));
  });

  // ── 加粗 / 斜体 ────────────────────────────────────────────────────

  $('strong, b').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(asText(`**${text}**`));
  });

  $('em, i').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(asText(`*${text}*`));
  });

  // ── 换行 ────────────────────────────────────────────────────────────

  $('br').replaceWith('\n');

  // ── 提取文本并清理 ──────────────────────────────────────────────────

  // 代码块内保留缩进与空行，只清理代码块之外的文本（split 后奇数下标是代码块）
  const parts = $.text()
    .replace(/\r\n/g, '\n')
    .split(/(\n```[^\n]*\n[\s\S]*?\n```\n)/);
  const markdown = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let text = part
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ {2,}/g, ' ');
      // 与代码块相邻处最多留一个空行
      if (i > 0) text = text.replace(/^\n+/, '\n');
      if (i < parts.length - 1) text = text.replace(/\n+$/, '\n');
      return text;
    })
    .join('')
    .trim();

  return `# ${title}\n\n${markdown}`;
}

// ── API 路径提取 ──────────────────────────────────────────────────────────────

/**
 * 从 Markdown 中提取 API 路径。
 * 钉钉的 API 路径有两种格式：
 * - 新版：POST /v1.0/oauth2/accessToken
 * - 旧版：POST https://oapi.dingtalk.com/topapi/...
 */
function extractApiPath(md: string): string | undefined {
  const patterns = [
    // 新版 API: POST /v1.0/oauth2/accessToken
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/v\d+\.\d+\/[^\s`'"<>]+)/i,
    // 旧版 API: POST https://oapi.dingtalk.com/topapi/...
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(https?:\/\/(?:oapi|api)\.dingtalk\.com[^\s`'"<>]+)/i,
    // 内联代码中的 API 路径
    /`((?:GET|POST|PUT|DELETE|PATCH)\s+[^\s`]+)`/i,
  ];

  for (const pat of patterns) {
    const m = md.match(pat);
    if (m) return m[1];
  }
  return undefined;
}

// ── 错误码提取 ────────────────────────────────────────────────────────────────

function extractErrorCodes(
  md: string,
): Array<{ code: string; message?: string; description?: string }> {
  const regex = /\|\s*(\d{3,6})\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;
  const codes: Array<{
    code: string;
    message?: string;
    description?: string;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(md)) !== null) {
    codes.push({
      code: m[1].trim(),
      message: m[2]?.trim() || undefined,
      description: m[3]?.trim() || undefined,
    });
  }
  return codes;
}
