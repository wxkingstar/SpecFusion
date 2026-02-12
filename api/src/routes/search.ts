import type { FastifyInstance } from 'fastify';
import { search, formatSearchResults } from '../services/search-engine.js';

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/search', async (request, reply) => {
    const { q, source, mode, limit } = request.query as {
      q?: string;
      source?: string;
      mode?: string;
      limit?: string;
    };

    if (!q) {
      reply.code(400).type('text/markdown; charset=utf-8');
      return '## 参数错误\n\n`q` 参数为必填项。';
    }

    const limitNum = Math.min(Math.max(parseInt(limit || '5', 10), 1), 20);

    const { results, totalCount, tookMs } = search({
      query: q,
      source: source || undefined,
      mode: mode || undefined,
      limit: limitNum,
    });

    const markdown = formatSearchResults(q, results, source, totalCount, tookMs);

    reply.type('text/markdown; charset=utf-8');
    return markdown;
  });
}
