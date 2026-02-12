/** Rate limit 配置 - 在 index.ts 中通过 @fastify/rate-limit 注册 */
export const rateLimitConfig = {
  search: { max: 60, timeWindow: '1 minute' },
  doc: { max: 120, timeWindow: '1 minute' },
  sources: { max: 30, timeWindow: '1 minute' },
  global: { max: 1000, timeWindow: '1 day' },
};
