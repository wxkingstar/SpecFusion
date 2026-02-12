import type { FastifyInstance } from 'fastify';
import { getDocument } from '../services/doc-store.js';
import { generateSummary } from '../services/summarizer.js';

export async function docRoutes(fastify: FastifyInstance) {
  fastify.get('/doc/:docId', async (request, reply) => {
    const { docId } = request.params as { docId: string };
    const { summary } = request.query as { summary?: string };

    const doc = getDocument(docId);

    if (!doc) {
      reply.code(404).type('text/markdown; charset=utf-8');
      return `## 文档未找到\n\n文档 ID \`${docId}\` 不存在。`;
    }

    reply.type('text/markdown; charset=utf-8');

    if (summary === 'true') {
      return generateSummary(doc.content, doc.id, doc.source_id);
    }

    // 在全文前添加元信息注释
    const header = [
      `<!-- source: ${doc.source_id} | path: ${doc.path} -->`,
      doc.source_url ? `<!-- source_url: ${doc.source_url} -->` : null,
      doc.last_updated ? `<!-- last_updated: ${doc.last_updated} -->` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n');

    return header + doc.content;
  });
}
