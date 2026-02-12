import type { FastifyInstance } from 'fastify';
import { getSources, getDb } from '../services/doc-store.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    const sources = getSources();
    const totalDocs = (
      getDb().prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number }
    ).cnt;

    return {
      status: 'ok',
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        doc_count: s.doc_count,
        last_synced: s.last_synced,
      })),
      total_docs: totalDocs,
    };
  });
}
