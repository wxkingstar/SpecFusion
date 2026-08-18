import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9223');
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('pinduoduo')) || (await ctx.newPage());

page.on('request', (req) => {
  if (req.url().endsWith('/pop/doc/info/get')) {
    console.log('REQ HEADERS:', JSON.stringify(req.headers(), null, 1));
  }
});
page.on('response', (resp) => {
  if (resp.url().endsWith('/pop/doc/info/get')) {
    console.log('RESP STATUS:', resp.status());
  }
});

await page.goto('https://open.pinduoduo.com/application/document/api?id=pdd.pop.auth.token.create', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(8000);
await b.close();
