import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { initDatabase } from './services/doc-store.js';
import { searchRoutes } from './routes/search.js';
import { docRoutes } from './routes/doc.js';
import { sourcesRoutes } from './routes/sources.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { categoriesRoutes } from './routes/categories.js';
import { recentRoutes } from './routes/recent.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
const DB_PATH = process.env.DB_PATH || './data/specfusion.db';

async function main() {
  const fastify = Fastify({
    logger: true,
    bodyLimit: 50 * 1024 * 1024, // 50MB — bulk-upsert 可能传大量文档
  });

  await fastify.register(cors, { origin: true });
  await fastify.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    allowList: (req: { url?: string }) => {
      // admin 路由豁免限速 — 避免 bulk sync 时被 60/min 限制
      return req.url?.startsWith('/api/admin/') ?? false;
    },
  });

  const db = initDatabase(DB_PATH);

  fastify.decorate('db', db);

  await fastify.register(searchRoutes, { prefix: '/api' });
  await fastify.register(docRoutes, { prefix: '/api' });
  await fastify.register(sourcesRoutes, { prefix: '/api' });
  await fastify.register(adminRoutes, { prefix: '/api' });
  await fastify.register(healthRoutes, { prefix: '/api' });
  await fastify.register(categoriesRoutes, { prefix: '/api' });
  await fastify.register(recentRoutes, { prefix: '/api' });

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`SpecFusion API running on http://localhost:${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
