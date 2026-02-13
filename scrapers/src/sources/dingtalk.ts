import { chromium, type Browser, type Page } from 'playwright';
import { load } from 'cheerio';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ── 常量 ──────────────────────────────────────────────────────────────────────

const DINGTALK_BASE = 'https://open.dingtalk.com';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 每次导航间隔（ms），避免触发风控 */
const NAV_DELAY = 300;

/** 页面加载超时（ms） */
const PAGE_TIMEOUT = 30_000;

/** 内容选择器等待超时（ms） */
const SELECTOR_TIMEOUT = 15_000;

// ── Tab 配置 ──────────────────────────────────────────────────────────────────

interface TabConfig {
  /** Tab 显示名称 */
  name: string;
  /** Tab 内任意文档页 URL（用于触发加载该 Tab 的导航树） */
  seedUrl: string;
}

/**
 * 需要爬取的 Tab 列表。
 * 每个 Tab 对应钉钉文档站侧边栏的一个独立导航树。
 * 通过导航到 seedUrl 加载该 Tab 的 Ant Design Tree 组件。
 *
 * 如需新增 Tab，找到该 Tab 下任意一篇文档的 URL 作为 seedUrl 即可。
 */
const TABS: TabConfig[] = [
  {
    name: '企业内部应用',
    seedUrl: `${DINGTALK_BASE}/document/orgapp/obtain-the-access_token-of-an-internal-app`,
  },
  {
    name: '服务端API',
    seedUrl: `${DINGTALK_BASE}/document/development/development-basic-concepts`,
  },
  {
    name: '客户端JSAPI',
    seedUrl: `${DINGTALK_BASE}/document/development/jsapi-overview`,
  },
];

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface RawTreeNode {
  title: string;
  slug: string;
  docUrl: string | null;
  type: string;
  path: string;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── DingtalkSource ────────────────────────────────────────────────────────────

/**
 * 钉钉开放平台文档源适配器
 *
 * 使用 Playwright 打开钉钉文档站，通过 React fiber state
 * 提取 Ant Design Tree 的 treeData 获取完整目录，
 * 再逐页导航提取 HTML 内容并转换为 Markdown。
 */
export class DingtalkSource implements DocSource {
  id = 'dingtalk';
  name = '钉钉';

  private browser: Browser | null = null;
  private page: Page | null = null;
  private dialogsDismissed = false;

  // ── 浏览器生命周期 ──────────────────────────────────────────────────────

  private async ensureBrowser(): Promise<Page> {
    if (this.page && this.browser?.isConnected()) {
      return this.page;
    }

    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
    });

    const context = await this.browser.newContext({ userAgent: USER_AGENT });
    this.page = await context.newPage();
    return this.page;
  }

  /** 关闭浏览器实例（同步结束后调用） */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
  }

  // ── fetchCatalog ────────────────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    const page = await this.ensureBrowser();
    const allDocs = new Map<string, { node: RawTreeNode; tabName: string }>();

    for (const tab of TABS) {
      console.log(`[dingtalk] 提取 Tab: ${tab.name} ...`);
      try {
        await page.goto(tab.seedUrl, {
          waitUntil: 'networkidle',
          timeout: PAGE_TIMEOUT,
        });

        await this.dismissDialogs(page);

        // 等待 Ant Design Tree 组件加载
        await page.waitForSelector('[class*="ant-tree"]', {
          timeout: SELECTOR_TIMEOUT,
        });

        const nodes = await this.extractTreeNodes(page);
        console.log(`[dingtalk]   ${tab.name}: ${nodes.length} 篇文档`);

        for (const node of nodes) {
          if (!node.docUrl) continue;
          const key = node.docUrl;
          const existing = allDocs.get(key);
          // 去重：以 docUrl 为键，保留 path 更深（更具体分类）的版本
          if (
            !existing ||
            node.path.split('/').length > existing.node.path.split('/').length
          ) {
            allDocs.set(key, { node, tabName: tab.name });
          }
        }

        await delay(NAV_DELAY);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[dingtalk]   Tab "${tab.name}" 提取失败，跳过: ${msg}`);
      }
    }

    // 转换为 DocEntry
    const entries: DocEntry[] = [];
    for (const [docUrl, { node, tabName }] of allDocs) {
      const sourceUrl = docUrl.startsWith('http')
        ? docUrl
        : `${DINGTALK_BASE}${docUrl.startsWith('/') ? '' : '/'}${docUrl}`;

      entries.push({
        path: `${tabName}/${node.path}`,
        title: node.title,
        sourceUrl,
        docType: detectDocType(node.path, sourceUrl),
        platformId: node.slug || docUrl,
      });
    }

    console.log(
      `[dingtalk] 目录提取完成，共 ${entries.length} 篇文档（去重后）`,
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

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT,
    });

    await this.dismissDialogs(page);

    // 等待文档内容区域加载（不依赖 networkidle，直接等选择器）
    await page.waitForSelector('.icms-help-docs-content', {
      timeout: SELECTOR_TIMEOUT,
    });

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

    return {
      markdown,
      apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata: raw.lastUpdated
        ? { last_updated: raw.lastUpdated }
        : undefined,
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

  /**
   * 从 React fiber state 提取 Ant Design Tree 的 treeData。
   * 使用字符串形式的 evaluate 避免 tsx 编译器注入 __name 装饰器。
   */
  private async extractTreeNodes(page: Page): Promise<RawTreeNode[]> {
    const result = await page.evaluate(`(() => {
      const treeEl = document.querySelector('[class*="ant-tree"]');
      if (!treeEl) return { error: 'ant-tree not found' };

      const fiberKey = Object.keys(treeEl).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return { error: 'React fiber not found' };

      let fiber = treeEl[fiberKey];
      let treeData = null;
      let attempts = 0;
      while (fiber && attempts < 30) {
        if (fiber.memoizedProps && fiber.memoizedProps.treeData) {
          treeData = fiber.memoizedProps.treeData;
          break;
        }
        fiber = fiber.return;
        attempts++;
      }
      if (!treeData) return { error: 'treeData not found in fiber' };

      const extractText = (el) => {
        if (!el) return '';
        if (typeof el === 'string') return el;
        if (typeof el === 'number') return String(el);
        if (Array.isArray(el)) return el.map(extractText).join('');
        if (el.props) return extractText(el.props.children);
        return '';
      };

      const flatten = (nodes, parentPath, out) => {
        for (const n of nodes) {
          const title = extractText(n.title).trim();
          const path = parentPath ? parentPath + '/' + title : title;
          if (n.docUrl) {
            out.push({
              title,
              slug: n.slug || '',
              docUrl: n.docUrl,
              type: n.type || '',
              path,
            });
          }
          if (n.children) flatten(n.children, path, out);
        }
        return out;
      };

      return flatten(treeData, '', []);
    })()`);

    if (!Array.isArray(result)) {
      const errMsg =
        typeof result === 'object' && result !== null && 'error' in result
          ? (result as { error: string }).error
          : 'unknown error';
      throw new Error(`树数据提取失败: ${errMsg}`);
    }

    return result as RawTreeNode[];
  }

  /** 从文档页 DOM 提取标题、更新日期和正文 HTML */
  private async extractPageContent(
    page: Page,
  ): Promise<
    | { title: string; lastUpdated: string; fullHtml: string }
    | { error: string }
  > {
    return page.evaluate(`(() => {
      const container = document.querySelector('.icms-help-docs-content');
      if (!container) return { error: 'icms-help-docs-content not found' };

      const main = container.querySelector('main');
      if (!main) return { error: 'main element not found' };

      const h1 = main.querySelector('h1');
      const title = h1 ? h1.textContent.trim() : '';

      const shortdesc = main.querySelector('.shortdesc');
      const dateMatch = shortdesc
        ? shortdesc.textContent.match(/更新于\\s*(\\d{4}-\\d{2}-\\d{2})/)
        : null;
      const lastUpdated = dateMatch ? dateMatch[1] : '';

      const conbody = main.querySelector('.conbody');
      const fullHtml = conbody ? conbody.innerHTML : main.innerHTML;

      return { title, lastUpdated, fullHtml };
    })()`) as any;
  }
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
 * 基于 PoC 验证的转换逻辑，额外处理钉钉特有的 HTML 结构：
 * - 代码块行号（<td class="code-line-number">）
 * - 告警框（.icms-help-docs-alert / [class*="note"]）
 * - API 参数表格
 */
function htmlToMarkdown(html: string, title: string): string {
  const $ = load(html);

  // ── 预处理：移除无用元素 ────────────────────────────────────────────

  $('script, style, .doc-recommend-section').remove();

  // 钉钉特有：代码块中的行号列
  $('td.code-line-number, td[class*="line-number"]').remove();

  // ── 代码块 ──────────────────────────────────────────────────────────

  $('pre').each((_, el) => {
    const $el = $(el);
    const codeEl = $el.find('code');
    const lang = codeEl.attr('class')?.match(/language-(\w+)/)?.[1] || '';
    const text = codeEl.text() || $el.text();
    $el.replaceWith(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`);
  });

  // 内联 code
  $('code').each((_, el) => {
    const $el = $(el);
    if ($el.parent().is('pre')) return;
    $el.replaceWith('`' + $el.text().replace(/`/g, '\\`') + '`');
  });

  // ── 标题 ────────────────────────────────────────────────────────────

  for (let i = 1; i <= 6; i++) {
    $(`h${i}`).each((_, el) => {
      const $el = $(el);
      $el.replaceWith(`\n${'#'.repeat(i)} ${$el.text().trim()}\n`);
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
    $table.replaceWith(md);
  });

  // ── 告警 / 提示框（钉钉特有） ──────────────────────────────────────

  $(
    '.icms-help-docs-alert, [class*="note"], [class*="warning"], [class*="important"], [class*="notice"]',
  ).each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(`\n> **注意**: ${text}\n`);
    }
  });

  // ── 链接 ────────────────────────────────────────────────────────────

  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    const text = $el.text().trim();
    if (href && text) {
      $el.replaceWith(`[${text}](${href})`);
    } else if (text) {
      $el.replaceWith(text);
    }
  });

  // ── 图片 ────────────────────────────────────────────────────────────

  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    const alt = $el.attr('alt') || '';
    if (src) {
      $el.replaceWith(`![${alt}](${src})`);
    }
  });

  // ── 列表 ────────────────────────────────────────────────────────────

  $('ul').each((_, el) => {
    const $el = $(el);
    let md = '\n';
    $el.find('> li').each((_, li) => {
      md += `- ${$(li).text().trim()}\n`;
    });
    $el.replaceWith(md + '\n');
  });

  $('ol').each((_, el) => {
    const $el = $(el);
    let md = '\n';
    $el.find('> li').each((i, li) => {
      md += `${i + 1}. ${$(li).text().trim()}\n`;
    });
    $el.replaceWith(md + '\n');
  });

  // ── 加粗 / 斜体 ────────────────────────────────────────────────────

  $('strong, b').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`**${text}**`);
  });

  $('em, i').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) $el.replaceWith(`*${text}*`);
  });

  // ── 换行 ────────────────────────────────────────────────────────────

  $('br').replaceWith('\n');

  // ── 提取文本并清理 ──────────────────────────────────────────────────

  let markdown = $.text()
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
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
