/**
 * 全局抓取节奏控制。
 *
 * 各源内部的请求间隔、重试退避都走这里的 `delay()`，通过环境变量
 * `SPECFUSION_PACE` 统一放大倍率，用于给反爬严格的站点降速：
 *
 *   SPECFUSION_PACE=2 npx tsx scrapers/src/cli.ts sync taobao   # 间隔翻倍
 *
 * 默认 1（保持各源原有配置）。非法值或 <= 0 一律退回 1。
 */
const raw = Number(process.env.SPECFUSION_PACE ?? '1');

export const PACE = Number.isFinite(raw) && raw > 0 ? raw : 1;

/** 按全局倍率放大后的休眠 */
export const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.round(ms * PACE)));
