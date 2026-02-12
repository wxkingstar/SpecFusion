import type { FastifyInstance } from 'fastify';
import { getSources } from '../services/doc-store.js';

export async function sourcesRoutes(fastify: FastifyInstance) {
  fastify.get('/sources', async (_request, reply) => {
    const sources = getSources();

    const lines: string[] = [
      '## 已接入文档源',
      '',
      '| 平台 | source 参数 | 文档数量 | 最后同步 |',
      '|------|-----------|---------|---------|',
    ];

    for (const s of sources) {
      lines.push(
        `| ${s.name} | ${s.id} | ${s.doc_count.toLocaleString()} | ${s.last_synced ?? '-'} |`,
      );
    }

    if (sources.length === 0) {
      lines.push('| — | — | — | — |');
      lines.push('');
      lines.push('暂无已接入的文档源。');
    }

    reply.type('text/markdown; charset=utf-8');
    return lines.join('\n');
  });
}
