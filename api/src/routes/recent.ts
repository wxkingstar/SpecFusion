import type { FastifyInstance } from 'fastify';
import { getDb } from '../services/doc-store.js';

const SOURCE_NAME_MAP: Record<string, string> = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
};

function sourceName(sourceId: string): string {
  return SOURCE_NAME_MAP[sourceId] ?? sourceId;
}

export async function recentRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Querystring: { source?: string; days?: string; limit?: string };
  }>('/recent', async (request, reply) => {
    const { source, days: rawDays, limit: rawLimit } = request.query;
    const days = Math.min(parseInt(rawDays || '7', 10) || 7, 90);
    const limit = Math.min(parseInt(rawLimit || '20', 10) || 20, 100);
    const db = getDb();

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const params: unknown[] = [cutoff, cutoff];
    let whereExtra = '';

    if (source) {
      whereExtra += ' AND source_id = ?';
      params.push(source);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT id, source_id, title, path, api_path, dev_mode, doc_type,
                source_url, last_updated, synced_at
         FROM documents
         WHERE (last_updated >= ? OR synced_at >= ?)${whereExtra}
         ORDER BY COALESCE(last_updated, synced_at) DESC
         LIMIT ?`,
      )
      .all(...params) as {
      id: string;
      source_id: string;
      title: string;
      path: string;
      api_path?: string;
      dev_mode?: string;
      doc_type: string;
      source_url?: string;
      last_updated?: string;
      synced_at: string;
    }[];

    reply.type('text/markdown; charset=utf-8');

    const sourceLabel = source ? sourceName(source) : '全部';

    if (rows.length === 0) {
      return `## 最近更新（来源：${sourceLabel}，${days} 天内）\n\n暂无更新。`;
    }

    const lines: string[] = [
      `## 最近更新（来源：${sourceLabel}，${days} 天内，共 ${rows.length} 条）`,
      '',
      '| 标题 | 来源 | 更新时间 | 文档ID |',
      '|------|------|---------|--------|',
    ];

    for (const row of rows) {
      const updated = row.last_updated || row.synced_at;
      const dateStr = updated ? updated.slice(0, 10) : '-';
      lines.push(
        `| ${row.title} | ${sourceName(row.source_id)} | ${dateStr} | ${row.id} |`,
      );
    }

    return lines.join('\n');
  });
}
