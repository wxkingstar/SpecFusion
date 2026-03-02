#!/usr/bin/env npx tsx
/**
 * 独立脚本：打开浏览器获取企业微信开发者文档的 cookies
 * 用法：npx tsx scrapers/get-cookies.ts
 */
import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

const BASE_URL = 'https://developer.work.weixin.qq.com';
const TARGET_URL = `${BASE_URL}/document/path/90664`;
const COOKIE_FILE = path.resolve(import.meta.dirname, '..', '.wecom_cookies.json');

async function main() {
  console.log('[get-cookies] 正在启动浏览器...');
  console.log('[get-cookies] 请在浏览器中完成登录或人机验证');
  console.log('[get-cookies] 完成后页面会自动检测并关闭浏览器\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('[get-cookies] 页面已打开，等待登录/验证完成...\n');

    // 等待文档内容出现（说明登录/验证成功）
    await page.waitForFunction(
      `(() => {
        const docContent = document.querySelector('.doc-content, .markdown-body, [class*="doc-"]');
        const loginForm = document.querySelector('[class*="login"], [class*="captcha"], [class*="verify"]');
        return docContent && !loginForm;
      })()`,
      { timeout: 300000 }, // 5 分钟
    );

    console.log('[get-cookies] ✓ 检测到登录/验证成功！');

    const cookies = await context.cookies();
    const relevant = cookies.filter(
      (c) => c.domain.includes('work.weixin.qq.com') || c.domain.includes('weixin.qq.com'),
    );

    if (relevant.length > 0) {
      await fs.writeJson(COOKIE_FILE, relevant, { spaces: 2 });
      console.log(`[get-cookies] ✓ 已保存 ${relevant.length} 个 cookies 到 ${COOKIE_FILE}`);
    } else {
      console.error('[get-cookies] ✗ 未获取到有效 cookies');
      process.exit(1);
    }
  } catch (error: any) {
    if (error.name === 'TimeoutError') {
      console.error('[get-cookies] ✗ 等待超时（5分钟），请重试');
    } else {
      console.error('[get-cookies] ✗ 出错:', error.message);
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
