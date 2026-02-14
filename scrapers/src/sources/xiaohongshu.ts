import { chromium, type Browser, type Page } from 'playwright';
import { load } from 'cheerio';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ── 常量 ──────────────────────────────────────────────────────────────────────

const XHS_BASE = 'https://open.xiaohongshu.com';
const CATALOG_URL = `${XHS_BASE}/document/api`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 每次导航间隔（ms），避免触发风控 */
const NAV_DELAY = 500;

/** 页面加载超时（ms） */
const PAGE_TIMEOUT = 30_000;

/** 内容选择器等待超时（ms） */
const SELECTOR_TIMEOUT = 15_000;

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface CatalogItem {
  category: string;
  apiMethod: string;
  description: string;
  url: string;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── XiaohongshuSource ─────────────────────────────────────────────────────────

/**
 * 小红书电商开放平台文档源适配器
 *
 * 使用 Playwright 打开小红书文档站（Vue 3 SSR），
 * 通过 DOM 交互提取左侧导航目录和 API 文档内容，
 * 再逐页导航提取 HTML 内容并转换为 Markdown。
 */
export class XiaohongshuSource implements DocSource {
  id = 'xiaohongshu';
  name = '小红书';

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
    const allItems: CatalogItem[] = [];

    console.log('[xiaohongshu] 导航到文档首页...');
    await page.goto(CATALOG_URL, {
      waitUntil: 'networkidle',
      timeout: PAGE_TIMEOUT,
    });

    // 关闭"工单中心已上线"弹窗
    await this.dismissDialogs(page);

    // 等待左侧分类导航加载（.menu-item 在零尺寸容器内，用 attached 等待 DOM 存在）
    await page.waitForSelector('.menu-item', {
      state: 'attached',
      timeout: SELECTOR_TIMEOUT,
    });

    // 获取所有分类标签
    const categories = await page.$$eval('.menu-item', (els) =>
      els.map((el) => el.textContent?.trim() || ''),
    );
    console.log(`[xiaohongshu] 发现 ${categories.length} 个分类: ${categories.join(', ')}`);

    for (let i = 0; i < categories.length; i++) {
      const categoryName = categories[i];
      if (!categoryName) continue;

      console.log(`[xiaohongshu]   提取分类: ${categoryName} ...`);

      try {
        // 分类标签在零尺寸 CSS-in-JS 容器内，Playwright click 会因不可见而超时
        // 改用 JS dispatch click 切换分类（字符串形式避免 tsx 编译器注入 DOM 类型）
        await page.evaluate(`(() => {
          const items = document.querySelectorAll('.menu-item');
          if (items[${i}]) items[${i}].click();
        })()`);

        // 等待 submenu 内容更新（分类名变化）
        await page.waitForFunction(`(() => {
          const nav = document.querySelector('.submenu-navigation');
          return nav && nav.textContent.trim() === ${JSON.stringify(categoryName)};
        })()`, { timeout: SELECTOR_TIMEOUT });
        await delay(NAV_DELAY);

        // 提取该分类下所有 API 项，逐个点击获取 URL
        const submenuCount = await page.locator('.submenu-item').count();
        console.log(`[xiaohongshu]     ${categoryName}: ${submenuCount} 个 API`);

        for (let j = 0; j < submenuCount; j++) {
          try {
            const submenuItems = page.locator('.submenu-item');
            const item = submenuItems.nth(j);

            // 提取 API 方法名和描述
            const apiMethod = await item.locator('.submenu-item-path').textContent() || '';
            const description = await item.locator('.submenu-item-navigation').textContent() || '';

            // 点击获取 URL（submenu-item 是可见的）
            await item.click();
            await delay(NAV_DELAY);

            const currentUrl = page.url();

            if (apiMethod.trim()) {
              allItems.push({
                category: categoryName,
                apiMethod: apiMethod.trim(),
                description: description.trim(),
                url: currentUrl,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[xiaohongshu]     第 ${j + 1} 项提取失败，跳过: ${msg}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[xiaohongshu]   分类 "${categoryName}" 提取失败，跳过: ${msg}`);
      }
    }

    // 去重（以 URL 为键）
    const urlMap = new Map<string, CatalogItem>();
    for (const item of allItems) {
      urlMap.set(item.url, item);
    }

    // 转换为 DocEntry[]
    const entries: DocEntry[] = [];
    for (const item of urlMap.values()) {
      const title = item.description
        ? `${item.apiMethod} ${item.description}`
        : item.apiMethod;

      entries.push({
        path: `${item.category}/${item.apiMethod}`,
        title,
        sourceUrl: item.url,
        docType: 'api_reference',
        platformId: item.apiMethod,
      });
    }

    console.log(
      `[xiaohongshu] 目录提取完成，共 ${entries.length} 篇文档（去重后）`,
    );
    return entries;
  }

  // ── fetchContent ────────────────────────────────────────────────────────

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const page = await this.ensureBrowser();
    const url = entry.sourceUrl;

    if (!url) {
      throw new Error(`[xiaohongshu] 文档缺少 sourceUrl: ${entry.title}`);
    }

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT,
    });

    // 等待内容容器加载
    await page.waitForSelector('.browser-container', {
      state: 'attached',
      timeout: SELECTOR_TIMEOUT,
    });

    // 展开所有折叠区域
    await this.expandAllSections(page);

    // 提取 HTML 内容
    const html = await page.evaluate(`(() => {
      const container = document.querySelector('.browser-container');
      if (!container) return '';
      return container.innerHTML;
    })()`);

    if (!html) {
      throw new Error(
        `[xiaohongshu] 内容提取失败 (${entry.title}): browser-container 为空`,
      );
    }

    const markdown = htmlToMarkdown(html as string, entry.title);
    const apiPath = extractApiPath(markdown, entry.title);
    const errorCodes = extractErrorCodes(markdown);

    await delay(NAV_DELAY);

    return {
      markdown,
      apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
    };
  }

  // ── detectUpdates ───────────────────────────────────────────────────────

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    // 简单实现：返回全量目录，由 sync 层通过内容对比判断实际变更
    return this.fetchCatalog();
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────

  /** 关闭"工单中心已上线"等弹窗（仅首次） */
  private async dismissDialogs(page: Page): Promise<void> {
    if (this.dialogsDismissed) return;
    try {
      const knowBtn = page.locator('.know-btn');
      if (await knowBtn.count() > 0) {
        await knowBtn.click({ timeout: 3000 });
        await delay(300);
      }
    } catch {
      /* 无弹窗 */
    }
    this.dialogsDismissed = true;
  }

  /** 展开所有折叠的 "点击展开" 区域 */
  private async expandAllSections(page: Page): Promise<void> {
    try {
      // 查找所有含"点击展开"文本的可点击元素
      const expandButtons = await page.$$('.section-wrapper-item');
      for (const btn of expandButtons) {
        const text = await btn.evaluate((el) => el.textContent?.trim() || '');
        if (text.includes('点击展开')) {
          await btn.click();
          await delay(200);
        }
      }
    } catch {
      /* 无折叠区域或点击失败，不影响主流程 */
    }
  }
}

// ── HTML → Markdown 转换 ─────────────────────────────────────────────────────

/**
 * 将小红书文档 HTML 转换为 Markdown。
 * 处理小红书特有的 HTML 结构：
 * - textarea → 代码块（JSON 自动标记语言）
 * - .section-wrapper-item-label → ## 标题
 * - 通用表格、链接、列表、加粗等转换
 */
function htmlToMarkdown(html: string, title: string): string {
  const $ = load(html);

  // ── 预处理：移除无用元素 ────────────────────────────────────────────
  $('script, style').remove();

  // ── 小红书特有：section 标题 ────────────────────────────────────────
  $('.section-wrapper-item-label').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      $el.replaceWith(`\n## ${text}\n`);
    }
  });

  // ── 小红书特有：textarea → 代码块 ──────────────────────────────────
  $('textarea').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (!text) return;
    // 尝试判断是否为 JSON
    const lang = text.startsWith('{') || text.startsWith('[') ? 'json' : '';
    $el.replaceWith(`\n\`\`\`${lang}\n${text}\n\`\`\`\n`);
  });

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
 * 从 Markdown 或标题中提取 API 方法名。
 * 小红书 API 方法格式：namespace.methodName（如 common.getCategories）
 */
function extractApiPath(md: string, title: string): string | undefined {
  // 从标题中提取（如 "common.getCategories 获取类目"）
  const titleMatch = title.match(/^([\w.]+\.\w+)/);
  if (titleMatch) return titleMatch[1];

  // 从内容中提取 HTTP 方法 + 路径
  const httpMatch = md.match(
    /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s`'"<>]+)/i,
  );
  if (httpMatch) return httpMatch[1];

  return undefined;
}

// ── 错误码提取 ────────────────────────────────────────────────────────────────

function extractErrorCodes(
  md: string,
): Array<{ code: string; message?: string; description?: string }> {
  // 小红书错误码为负数（如 -1010001），正则需支持负号
  const regex = /\|\s*(-?\d{3,})\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;
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
