import { chromium, type Browser, type Page, type Response } from 'playwright';
import { tokenize } from '../utils/tokenizer.js';
import { collapseBlankLines } from '../utils/html-to-md.js';
import type { DocSource, DocEntry, DocContent } from '../types.js';

// ── 常量 ──────────────────────────────────────────────────────────────────────

const DEWU_BASE = 'https://open.dewu.com';
const API_PAGE_URL = `${DEWU_BASE}/#/api`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 每次导航间隔（ms） */
const NAV_DELAY = 800;

/** 页面加载超时（ms） */
const PAGE_TIMEOUT = 30_000;

/** API 响应等待超时（ms） */
const API_RESPONSE_TIMEOUT = 15_000;

/** 得物 API 响应中匹配的 URL 路径 */
const DOC_API_PATH = '/dop/h5/api/v2/doc';

// ── API 响应类型 ─────────────────────────────────────────────────────────────

interface DewuResponse<T> {
  code: number;
  msg: string;
  data: T;
}

interface DewuApiDetail {
  apiId: number;
  apiName: string;
  apiUrl: string;
  apiDesc: string;
  noticeContent?: string;
  free: boolean;
  needAuth: boolean;
  methodType: string;
  contentType: string;
  envs: Array<{ envName: string; envAddress: string }>;
  publicParam: DewuParam[];
  requestParam: DewuParam[];
  responseParam: DewuParam[];
  requestExamples?: DewuExample[];
  responseExamples?: DewuExample[];
  authPackage?: DewuAuthPackage[];
  errorCode?: DewuErrorCode[];
  modifyTime?: string | number;
}

interface DewuParam {
  id: number | null;
  paramName: string;
  paramType: string;
  mustResult: string;
  paramExample?: string | null;
  paramDesc: string;
  encryptFlag?: string | null;
  subParam?: DewuParam[] | null;
  transferParamName?: string | null;
}

interface DewuExample {
  language: string;
  content: string;
}

interface DewuAuthPackage {
  packageName: string;
  appTypeList: string[];
}

interface DewuErrorCode {
  errorCode: string;
  errorMsg: string;
  errorSolution?: string;
}

/** 从侧边栏 DOM 提取的目录条目 */
interface CatalogItem {
  categoryId: string;
  category: string;
  apiId: string;
  title: string;
  path: string;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function escapeCell(text: string): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 解析 modifyTime — 可能是字符串 "2022-07-13 19:39:28" 或 Unix 时间戳（秒/毫秒） */
function parseModifyTime(mt: string | number): string {
  if (typeof mt === 'string') return mt.split(' ')[0];
  // 区分秒级（< 10^10）和毫秒级（>= 10^10）时间戳
  const ms = mt < 1e10 ? mt * 1000 : mt;
  return new Date(ms).toISOString().split('T')[0];
}

// ── DewuSource ───────────────────────────────────────────────────────────────

/**
 * 得物开放平台文档源适配器
 *
 * 使用 Playwright 打开得物文档站（Vue 2 + React SPA），
 * 通过拦截 XHR 响应获取 API 详情数据，再转换为 Markdown。
 *
 * 技术要点：
 * - 得物使用 Go WebAssembly 生成请求签名（sign 参数）
 * - sign 只能在浏览器环境中生成，因此必须使用 Playwright
 * - 目录数据从 DOM 的 React 组件树中提取
 * - 详情数据通过拦截 /dop/h5/api/v2/doc 的 XHR 响应获取
 */
export class DewuSource implements DocSource {
  id = 'dewu';
  name = '得物开放平台';

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

  // ── API 响应拦截 ────────────────────────────────────────────────────────

  /**
   * 等待并捕获得物 API 详情的 XHR 响应。
   * 通过 page.on('response') 拦截，匹配 URL 中的 /dop/h5/api/v2/doc。
   */
  private waitForDocResponse(
    page: Page,
    timeout = API_RESPONSE_TIMEOUT,
  ): Promise<DewuResponse<DewuApiDetail>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        page.off('response', handler);
        reject(new Error(`[dewu] API 详情响应超时 (${timeout}ms)`));
      }, timeout);

      const handler = async (response: Response) => {
        try {
          const url = response.url();
          if (url.includes(DOC_API_PATH) && response.status() === 200) {
            clearTimeout(timer);
            page.off('response', handler);
            const body = await response.json();
            resolve(body as DewuResponse<DewuApiDetail>);
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

    console.log('[dewu] 导航到 API 文档页...');
    await page.goto(API_PAGE_URL, {
      waitUntil: 'networkidle',
      timeout: PAGE_TIMEOUT,
    });
    await delay(3000);

    // 展开所有折叠面板
    console.log('[dewu] 展开所有分类面板...');
    await page.evaluate(`(() => {
      const headers = document.querySelectorAll('.ant-collapse-header');
      headers.forEach(h => {
        const panel = h.closest('.ant-collapse-item');
        if (panel && !panel.classList.contains('ant-collapse-item-active')) {
          h.click();
        }
      });
    })()`);
    await delay(2000);

    // 从 DOM 中提取完整目录
    console.log('[dewu] 从 DOM 提取目录...');
    const catalog = await page.evaluate(`(() => {
      const items = [];
      const panels = document.querySelectorAll('.ant-collapse-item');

      panels.forEach(panel => {
        const headerText = panel.querySelector('.ant-collapse-header-text');
        const category = headerText ? headerText.textContent.trim() : '';
        const categoryId = panel.querySelector('.ant-collapse-header')?.getAttribute('aria-controls') || '';

        const contentBox = panel.querySelector('.ant-collapse-content-box');
        if (!contentBox) return;

        const apiDivs = contentBox.querySelectorAll('.cursor-pointer');
        apiDivs.forEach(div => {
          const titleEl = div.querySelector('.text-sm');
          const pathEl = div.querySelector('.text-xs');
          if (!titleEl) return;

          // 提取 apiId：通过模拟点击后的 URL 变化或从 React props 中获取
          // 这里通过 React fiber 获取 key（即 apiId）
          const fiberKey = Object.keys(div).find(k => k.startsWith('__reactFiber'));
          let apiId = '';
          if (fiberKey) {
            apiId = div[fiberKey]?.key || '';
          }

          items.push({
            categoryId,
            category,
            apiId,
            title: titleEl.getAttribute('title') || titleEl.textContent.trim(),
            path: pathEl?.getAttribute('title') || pathEl?.textContent.trim() || ''
          });
        });
      });

      return items;
    })()`) as CatalogItem[];

    console.log(`[dewu] 目录提取完成，共 ${catalog.length} 篇文档`);

    const entries: DocEntry[] = catalog
      .filter((item) => item.apiId && item.title)
      .map((item) => ({
        path: `${item.category}/${item.title}`,
        title: `${item.title}`,
        apiPath: item.path,
        docType: 'api_reference' as const,
        sourceUrl: `${DEWU_BASE}/#/api?apiId=${item.apiId}`,
        platformId: item.apiId,
      }));

    // 去重
    const seen = new Set<string>();
    const unique = entries.filter((e) => {
      if (seen.has(e.platformId!)) return false;
      seen.add(e.platformId!);
      return true;
    });

    console.log(`[dewu] 去重后 ${unique.length} 篇文档`);
    return unique;
  }

  // ── fetchContent ────────────────────────────────────────────────────────

  async fetchContent(entry: DocEntry): Promise<DocContent> {
    const page = await this.ensureBrowser();
    const apiId = entry.platformId;

    if (!apiId) {
      throw new Error(`[dewu] 文档缺少 platformId: ${entry.title}`);
    }

    // 注册响应拦截（在导航前）
    const responsePromise = this.waitForDocResponse(page);

    // 通过 hash 导航触发 API 详情请求
    const navUrl = `${DEWU_BASE}/?_=${Date.now()}#/api?apiId=${apiId}`;
    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    let detail: DewuApiDetail;
    try {
      const resp = await responsePromise;
      if (resp.code !== 200 || !resp.data) {
        throw new Error(`API 响应异常: code=${resp.code}, msg=${resp.msg}`);
      }
      detail = resp.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[dewu] 获取文档详情失败 (apiId=${apiId}): ${msg}`);
    }

    // 从 JSON 构建 Markdown
    const markdown = detailToMarkdown(detail);

    // 提取错误码
    const errorCodes = detail.errorCode?.map((ec) => ({
      code: ec.errorCode,
      message: ec.errorMsg,
      description: ec.errorSolution,
    }));

    // 分词
    const tokenizedTitle = tokenize(entry.title);
    const tokenizedContent = tokenize(markdown);

    const metadata: Record<string, unknown> = {
      tokenizedTitle,
      tokenizedContent,
    };

    if (detail.modifyTime) {
      metadata.lastUpdated = parseModifyTime(detail.modifyTime);
    }

    await delay(NAV_DELAY);

    return {
      markdown,
      apiPath: detail.apiUrl || entry.apiPath,
      errorCodes: errorCodes && errorCodes.length > 0 ? errorCodes : undefined,
      metadata,
    };
  }

  // ── detectUpdates ───────────────────────────────────────────────────────

  async detectUpdates(_since: Date): Promise<DocEntry[]> {
    return this.fetchCatalog();
  }
}

// ── JSON → Markdown 转换 ──────────────────────────────────────────────────────

/**
 * 将得物 API 详情 JSON 转换为 Markdown。
 * 直接从结构化 JSON 构建，无需 HTML 解析。
 */
function detailToMarkdown(detail: DewuApiDetail): string {
  const sections: string[] = [];

  // ── 标题 ──
  sections.push(`# ${detail.apiName}\n`);

  // ── 基本信息 ──
  if (detail.apiDesc) {
    sections.push(`${detail.apiDesc}\n`);
  }

  const tags: string[] = [];
  tags.push(`**${detail.methodType}** \`${detail.apiUrl}\``);
  if (detail.free) tags.push('免费');
  if (detail.needAuth) tags.push('需要授权');
  sections.push(`${tags.join(' | ')}\n`);

  if (detail.noticeContent) {
    sections.push(`> **注意：** ${detail.noticeContent}\n`);
  }

  if (detail.modifyTime) {
    sections.push(`更新时间：${parseModifyTime(detail.modifyTime)}\n`);
  }

  // ── 请求地址 ──
  if (detail.envs?.length > 0) {
    sections.push('## 请求地址\n');
    sections.push('| 环境 | 地址 |');
    sections.push('| --- | --- |');
    for (const env of detail.envs) {
      sections.push(`| ${escapeCell(env.envName)} | \`${escapeCell(env.envAddress)}\` |`);
    }
    sections.push('');
  }

  // ── 公共参数 ──
  if (detail.publicParam?.length > 0) {
    sections.push('## 公共参数\n');
    sections.push(paramsToTable(detail.publicParam));
  }

  // ── 请求参数 ──
  if (detail.requestParam?.length > 0) {
    sections.push('## 请求参数\n');
    sections.push(paramsToTable(detail.requestParam));
  }

  // ── 返回参数 ──
  if (detail.responseParam?.length > 0) {
    sections.push('## 返回参数\n');
    sections.push(paramsToTable(detail.responseParam));
  }

  // ── 请求示例 ──
  if (detail.requestExamples?.length) {
    sections.push('## 请求示例\n');
    for (const ex of detail.requestExamples) {
      const lang = ex.language?.toLowerCase() || '';
      sections.push(`### ${ex.language || '示例'}\n`);
      sections.push(`\`\`\`${lang === 'curl' ? 'bash' : lang}\n${ex.content}\n\`\`\`\n`);
    }
  }

  // ── 响应示例 ──
  if (detail.responseExamples?.length) {
    sections.push('## 响应示例\n');
    for (const ex of detail.responseExamples) {
      sections.push(`\`\`\`json\n${ex.content}\n\`\`\`\n`);
    }
  }

  // ── 错误码 ──
  if (detail.errorCode?.length) {
    sections.push('## 错误码\n');
    sections.push('| 错误码 | 错误信息 | 解决方案 |');
    sections.push('| --- | --- | --- |');
    for (const ec of detail.errorCode) {
      sections.push(
        `| ${escapeCell(ec.errorCode)} | ${escapeCell(ec.errorMsg)} | ${escapeCell(ec.errorSolution || '')} |`,
      );
    }
    sections.push('');
  }

  // ── 权限包 ──
  if (detail.authPackage?.length) {
    sections.push('## API 相关权限包\n');
    sections.push('| 权限包名称 | 应用类型 |');
    sections.push('| --- | --- |');
    for (const pkg of detail.authPackage) {
      sections.push(
        `| ${escapeCell(pkg.packageName)} | ${escapeCell(pkg.appTypeList?.join(', ') || '')} |`,
      );
    }
    sections.push('');
  }

  let result = sections.join('\n');
  result = collapseBlankLines(result).trim();
  return result;
}

// ── 参数表格生成 ──────────────────────────────────────────────────────────────

/**
 * 将参数列表转为 Markdown 表格，支持嵌套子参数（通过缩进层级展示）。
 */
function paramsToTable(params: DewuParam[], depth = 0): string {
  const lines: string[] = [];

  if (depth === 0) {
    lines.push('| 参数名称 | 参数类型 | 是否必填 | 参数示例 | 参数描述 |');
    lines.push('| --- | --- | --- | --- | --- |');
  }

  for (const p of params) {
    const indent = depth > 0 ? '└ '.repeat(depth) : '';
    const name = `${indent}${p.paramName}`;
    lines.push(
      `| ${escapeCell(name)} | ${escapeCell(p.paramType)} | ${escapeCell(p.mustResult)} | ${escapeCell(p.paramExample || '')} | ${escapeCell(p.paramDesc)} |`,
    );

    // 递归处理子参数
    if (p.subParam?.length) {
      const subLines = paramsToTable(p.subParam, depth + 1);
      // 跳过子表格的表头（前两行）
      const subRows = subLines.split('\n').slice(depth === 0 ? 0 : 0);
      lines.push(...subRows.filter((l) => l.trim()));
    }
  }

  return lines.join('\n') + '\n';
}
