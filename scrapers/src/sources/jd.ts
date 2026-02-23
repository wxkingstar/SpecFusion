import { chromium, type Browser, type Page, type Response } from 'playwright';
import { load } from 'cheerio';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines, stripHtmlComments } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ── 常量 ──────────────────────────────────────────────────────────────────────

const JD_BASE = 'https://open.jd.com';
const DOC_URL = `${JD_BASE}/v2/#/doc/api`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 每次导航间隔（ms），避免触发风控 */
const NAV_DELAY = 800;

/** 页面加载超时（ms） */
const PAGE_TIMEOUT = 30_000;

/** 内容选择器等待超时（ms） */
const SELECTOR_TIMEOUT = 15_000;

/** DSM API 响应超时（ms） */
const DSM_RESPONSE_TIMEOUT = 15_000;

/** SFF API host（京东 DSM 网关） */
const SFF_HOST = 'sff.jd.com';

// ── 业务模型 ──────────────────────────────────────────────────────────────────

interface BusinessModel {
  name: string;
  value: number;
}

/**
 * 京东 API 文档的业务模型分类。
 * POP（第三方商家）和自营是主要的文档来源。
 */
const BUSINESS_MODELS: BusinessModel[] = [
  { name: 'POP', value: 1 },
  { name: '自营', value: 3 },
];

// ── DSM API 响应类型 ─────────────────────────────────────────────────────────

interface DsmResponse<T> {
  code: number;
  msg: string;
  data: T;
}

/** listApiGroup 响应中的分类项 */
interface ApiGroup {
  id: number;             // 分类 ID（对应 URL 中的 apiCateId）
  groupName: string;      // 分类名称，如 "店铺API"
  josGroupId: number;     // JOS 分组 ID
  description?: string;
  groupOrder?: number;
  groupStatus?: number;
}

/** listApi4Overview 响应中的 API 项 */
interface ApiOverviewItem {
  id: number;             // API ID（对应 URL 中的 apiId）
  apiName: string;        // 英文方法名，如 jingdong.vender.shipaddress.query
  znName?: string;        // 中文名称
  apiDesc?: string;       // 描述
  groupId: number;        // 所属分类 ID
  gwType: number;         // 网关类型（0=API 1.0, 1=SP-API）
  josApiId?: number;      // JOS API ID
  modified?: number;      // 更新时间戳（毫秒）
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ── JdSource ─────────────────────────────────────────────────────────────────

/**
 * 京东商家开放平台文档源适配器
 *
 * 使用 Playwright 打开京东文档站（Vue 3 SPA + DSM 框架），
 * 通过拦截 sff.jd.com 的 API 响应获取目录数据，
 * 再逐页导航提取 DOM 内容并转换为 Markdown。
 *
 * 技术要点：
 * - 京东使用 DSM (Data Service Middleware) 框架，所有 API 请求需要 h5st 签名
 * - h5st 签名只能在浏览器环境中生成，因此必须使用 Playwright
 * - API 请求发送到 sff.jd.com/api，通过 appId 和签名参数鉴权
 */
export class JdSource implements DocSource {
  id = 'jd';
  name = '京东商家开放平台';

  private browser: Browser | null = null;
  private page: Page | null = null;

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

  // ── DSM API 响应拦截 ───────────────────────────────────────────────────

  /**
   * 等待并捕获 sff.jd.com 上指定 API 的响应。
   * 通过 page.on('response') 拦截，匹配 URL 中的 api= 参数。
   */
  private waitForDsmResponse<T>(
    page: Page,
    apiName: string,
    timeout = DSM_RESPONSE_TIMEOUT,
  ): Promise<DsmResponse<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        page.off('response', handler);
        reject(new Error(`[jd] DSM 响应超时: ${apiName} (${timeout}ms)`));
      }, timeout);

      const handler = async (response: Response) => {
        try {
          const url = response.url();
          if (
            url.includes(SFF_HOST) &&
            url.includes(`api=${apiName}`) &&
            response.status() === 200
          ) {
            clearTimeout(timer);
            page.off('response', handler);
            const body = await response.json();
            resolve(body as DsmResponse<T>);
          }
        } catch {
          /* 忽略非 JSON 响应 */
        }
      };

      page.on('response', handler);
    });
  }

  // ── fetchCatalog ────────────────────────────────────────────────────────

  async fetchCatalog(): Promise<DocEntry[]> {
    const page = await this.ensureBrowser();
    const entries: DocEntry[] = [];
    const seen = new Set<string>(); // 去重 key: businessModel:apiId

    console.log('[jd] 导航到 API 文档页...');
    await page.goto(DOC_URL, {
      waitUntil: 'networkidle',
      timeout: PAGE_TIMEOUT,
    });
    await delay(2000);

    for (const bm of BUSINESS_MODELS) {
      console.log(`[jd] 提取业务模型: ${bm.name} (businessModel=${bm.value})`);

      try {
        // 点击业务模型 Tab 并等待 listApiGroup 响应
        const groupPromise = this.waitForDsmResponse<ApiGroup[]>(
          page,
          'dsm.jdo.open.cms.api4home.listApiGroup',
        );

        // 点击对应 Tab（通过文本匹配）
        await page.evaluate(`(() => {
          const tabs = document.querySelectorAll('.jd-tabs__label');
          for (const tab of tabs) {
            if (tab.textContent.trim() === ${JSON.stringify(bm.name)}) {
              tab.click();
              return true;
            }
          }
          return false;
        })()`);

        await delay(1000);

        let groups: ApiGroup[];
        try {
          const groupResp = await groupPromise;
          if (groupResp.code !== 200 || !Array.isArray(groupResp.data)) {
            console.warn(`[jd]   listApiGroup 响应异常: code=${groupResp.code}`);
            continue;
          }
          groups = groupResp.data;
        } catch (err) {
          // Tab 切换可能不总是触发 API 调用（如果已缓存），尝试从 DOM 提取
          console.warn(`[jd]   未捕获 listApiGroup 响应，尝试从 DOM 提取分类`);
          groups = await this.extractCategoriesFromDom(page);
        }

        console.log(`[jd]   发现 ${groups.length} 个 API 分类`);

        for (const group of groups) {
          console.log(`[jd]   提取分类: ${group.groupName} (id=${group.id})`);

          try {
            const apis = await this.fetchGroupApis(page, group, bm);
            const realApis = apis.filter(a => a.apiName?.startsWith('jingdong.'));

            console.log(`[jd]     ${group.groupName}: ${realApis.length} 个 API`);

            for (const api of realApis) {
              const key = api.id > 0 ? `${bm.value}:${api.id}` : `${bm.value}:${api.apiName}`;
              if (seen.has(key)) continue;
              seen.add(key);

              const title = api.znName
                ? `${api.apiName}（${api.znName}）`
                : api.apiName;

              const sourceUrl = `${JD_BASE}/v2/#/doc/api?apiCateId=${group.id}&apiId=${api.id}&apiName=${encodeURIComponent(api.apiName)}&gwType=0`;

              const lastUpdated = api.modified
                ? new Date(api.modified).toISOString().split('T')[0]
                : undefined;

              entries.push({
                path: `${bm.name}/${group.groupName}/${api.apiName}`,
                title,
                apiPath: api.apiName,
                docType: 'api_reference',
                sourceUrl,
                platformId: api.id > 0 ? `${api.id}` : api.apiName,
                lastUpdated,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[jd]     分类 "${group.groupName}" 提取失败: ${msg}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[jd]   业务模型 "${bm.name}" 提取失败: ${msg}`);
      }
    }

    console.log(`[jd] 目录提取完成，共 ${entries.length} 篇文档（去重后）`);
    return entries;
  }

  // ── fetchContent ────────────────────────────────────────────────────────

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const page = await this.ensureBrowser();
    const url = entry.sourceUrl;

    if (!url) {
      throw new Error(`[jd] 文档缺少 sourceUrl: ${entry.title}`);
    }

    // cache-busting 加在 URL path 的 query 参数中（hash 前面），确保 Playwright 执行真实导航
    const hashPart = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    const navUrl = `${JD_BASE}/v2/?_=${Date.now()}${hashPart}`;
    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // 等待 API 文档内容加载
    try {
      await page.waitForSelector('.api-doc-content', {
        state: 'attached',
        timeout: SELECTOR_TIMEOUT,
      });
    } catch {
      // 如果 .api-doc-content 不存在，尝试等待更通用的内容容器
      await page.waitForSelector('.api-content-header, .doc-content', {
        state: 'attached',
        timeout: SELECTOR_TIMEOUT,
      });
    }

    // 等待内容完全渲染
    await delay(1000);

    // 提取 HTML 内容
    const html = await page.evaluate(`(() => {
      const container = document.querySelector('.api-doc-content');
      if (!container) return '';
      return container.innerHTML;
    })()`);

    if (!html) {
      throw new Error(`[jd] 内容提取失败 (${entry.title}): api-doc-content 为空`);
    }

    // 提取更新时间
    const lastUpdated = await page.evaluate(`(() => {
      const header = document.querySelector('.api-content-header');
      if (!header) return '';
      const text = header.textContent || '';
      const match = text.match(/更新时间[：:]\\s*(\\d{4}-\\d{2}-\\d{2})/);
      return match ? match[1] : '';
    })()`);

    const markdown = htmlToMarkdown(html as string, entry.title);
    const apiPath = entry.apiPath || extractApiPath(markdown, entry.title);
    const errorCodes = extractErrorCodes(markdown);

    // 分词
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (lastUpdated) {
      metadata.lastUpdated = lastUpdated;
    }

    await delay(NAV_DELAY);

    return {
      markdown,
      apiPath,
      errorCodes: errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  // ── detectUpdates ───────────────────────────────────────────────────────

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }

  // ── 分类 API 提取（多策略） ─────────────────────────────────────────────

  /**
   * 获取某个分类下的 API 列表。
   * 通过 page.goto 强制整页导航，拦截 DSM API 响应获取数据。
   * 失败时从 DOM 提取作为降级方案。
   */
  private async fetchGroupApis(
    page: Page,
    group: ApiGroup,
    bm: BusinessModel,
  ): Promise<ApiOverviewItem[]> {
    // 设置 API 响应监听（在导航前注册，确保能捕获）
    const promise = this.waitForDsmResponse<ApiOverviewItem[]>(
      page,
      'dsm.jdo.open.cms.api4home.listApi4Overview',
      10_000,
    );

    // 整页导航（cache-busting query 参数强制 Playwright 执行真实导航）
    const url = `${JD_BASE}/v2/?_=${Date.now()}#/doc/api?apiCateId=${group.id}&apiId=-${group.id}&apiName=${encodeURIComponent(group.groupName + 'API概览')}&gwType=0&businessModel=${bm.value}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    try {
      const resp = await promise;
      if (resp.code === 200 && Array.isArray(resp.data)) {
        return resp.data;
      }
    } catch {
      // DSM 响应超时或异常
    }

    // 降级: DOM 提取
    return this.extractApisFromOverviewDom(page);
  }

  // ── DOM 降级提取 ───────────────────────────────────────────────────────

  /**
   * 从 DOM 提取分类列表（API 响应拦截失败时的降级方案）。
   * 解析左侧菜单的 "概览" 项的 URL 参数。
   */
  private async extractCategoriesFromDom(page: Page): Promise<ApiGroup[]> {
    return page.evaluate(`(() => {
      const groups = [];

      // 尝试从 URL 参数中提取当前 apiCateId
      const hash = window.location.hash;
      const cateMatch = hash.match(/apiCateId=(\\d+)/);
      const cateName = hash.match(/apiName=([^&]+)/);

      if (cateMatch) {
        groups.push({
          id: parseInt(cateMatch[1]),
          groupName: cateName ? decodeURIComponent(cateName[1]).replace('API概览', '') : '未知分类',
          josGroupId: 0,
        });
      }

      return groups;
    })()`) as Promise<ApiGroup[]>;
  }

  /**
   * 从概览页 DOM 提取 API 列表（API 响应拦截失败时的降级方案）。
   * 解析概览表格中的 API 名称和描述。
   */
  private async extractApisFromOverviewDom(page: Page): Promise<ApiOverviewItem[]> {
    return page.evaluate(`(() => {
      const apis = [];

      // 方法1：从概览表格提取
      const rows = document.querySelectorAll('.api-list, table tr');
      for (const row of rows) {
        const nameEl = row.querySelector('.api-list__name, td:first-child');
        const descEl = row.querySelector('.api-list__desc, td:nth-child(2)');
        if (!nameEl) continue;

        const text = nameEl.textContent?.trim() || '';
        // 京东 API 名格式: jingdong.xxx.xxx
        const nameMatch = text.match(/(jingdong\\.[a-zA-Z0-9_.]+)/);
        if (!nameMatch) continue;

        apis.push({
          id: 0,
          apiName: nameMatch[1],
          znName: descEl?.textContent?.trim() || '',
          groupId: 0,
          gwType: 0,
        });
      }

      // 方法2：从左侧菜单提取
      if (apis.length === 0) {
        const menuItems = document.querySelectorAll('.jd-menu-item.menu-item-warp');
        for (const item of menuItems) {
          const apiNameEl = item.querySelector('.api-name');
          if (!apiNameEl) continue;
          const apiName = apiNameEl.textContent?.trim() || '';
          if (!apiName.startsWith('jingdong.')) continue;

          const descEl = item.querySelector('[class*="desc"]');
          apis.push({
            id: 0,
            apiName,
            znName: descEl?.textContent?.trim() || '',
            groupId: 0,
            gwType: 0,
          });
        }
      }

      return apis;
    })()`) as Promise<ApiOverviewItem[]>;
  }
}

// ── HTML → Markdown 转换 ─────────────────────────────────────────────────────

/**
 * 将京东 API 文档 HTML 转换为 Markdown。
 * 处理京东特有的 HTML 结构：
 * - .api-content-header → 标题和元信息
 * - .components-api-description → API 描述
 * - .component-api-request-params → 请求参数表格
 * - .api-panel.section → 请求/响应等区块
 * - 代码示例（多语言 Tab）
 */
function htmlToMarkdown(html: string, title: string): string {
  const $ = load(html);

  // ── 预处理：移除无用元素 ────────────────────────────────────────────
  $('script, style, .doc-feedback, .api-tools-wrapper, svg').remove();

  // ── 京东特有：API 头部信息 ─────────────────────────────────────────
  $('.api-content-header').each((_, el) => {
    const $el = $(el);
    // 提取版本、授权方式等 tag
    const tags: string[] = [];
    $el.find('.jd-tag, [class*="tag"]').each((_, tag) => {
      const text = $(tag).text().trim();
      if (text) tags.push(text);
    });
    const tagLine = tags.length > 0 ? `\n> ${tags.join(' | ')}\n` : '';
    $el.replaceWith(tagLine);
  });

  // ── 京东特有：API 描述区块 ─────────────────────────────────────────
  $('.components-api-description').each((_, el) => {
    const $el = $(el);
    const descText = $el.find('.api-description-text-content').text().trim();
    if (descText) {
      $el.replaceWith(`\n## API 描述\n\n${descText}\n`);
    }
  });

  // ── 京东特有：section 标题 ─────────────────────────────────────────
  $('.api-panel.section').each((_, el) => {
    const $el = $(el);
    // section 的标题通常在第一个子元素中
    const sectionTitle = $el.find('.api-panel-title, > div:first-child > span:first-child').first();
    if (sectionTitle.length) {
      const text = sectionTitle.text().trim();
      if (text && !text.includes('请求示例') && !text.includes('响应示例')) {
        sectionTitle.replaceWith(`\n## ${text}\n`);
      } else if (text) {
        sectionTitle.replaceWith(`\n### ${text}\n`);
      }
    }
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
          cells.push(escapeCell($(cell).text().trim()));
        });
      if (cells.length > 0) rows.push(cells);
    });

    if (rows.length === 0) return;

    const colCount = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];

    // 第一行作为表头
    const header = rows[0];
    while (header.length < colCount) header.push('');
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);

    // 数据行
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < colCount) row.push('');
      lines.push(`| ${row.join(' | ')} |`);
    }

    $table.replaceWith(`\n${lines.join('\n')}\n`);
  });

  // ── 链接 ────────────────────────────────────────────────────────────
  $('a').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const text = $el.text().trim();
    if (href && text && !href.startsWith('javascript:')) {
      const fullHref = href.startsWith('http') ? href : `${JD_BASE}${href}`;
      $el.replaceWith(`[${text}](${fullHref})`);
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
  let markdown = $.text();
  markdown = stripHtmlComments(markdown);
  markdown = markdown
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '') // 清理残留标签
    .replace(/\r\n/g, '\n');
  markdown = collapseBlankLines(markdown);
  markdown = markdown.replace(/ {2,}/g, ' ').trim();

  return `# ${title}\n\n${markdown}`;
}

// ── API 路径提取 ──────────────────────────────────────────────────────────────

/**
 * 从 Markdown 或标题中提取 API 方法名。
 * 京东 API 方法格式：jingdong.xxx.xxx（如 jingdong.vender.shipaddress.query）
 */
function extractApiPath(md: string, title: string): string | undefined {
  // 从标题中提取
  const titleMatch = title.match(/(jingdong\.[a-zA-Z0-9_.]+)/);
  if (titleMatch) return titleMatch[1];

  // 从内容中提取
  const contentMatch = md.match(/(jingdong\.[a-zA-Z0-9_.]+)/);
  if (contentMatch) return contentMatch[1];

  // 通用 HTTP 方法 + 路径
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
  const regex = /\|\s*(\d{3,})\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;
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
