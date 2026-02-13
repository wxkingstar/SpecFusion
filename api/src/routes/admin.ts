import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  upsertDocument,
  bulkUpsert,
  deleteDocument,
  upsertSource,
  upsertErrorCodes,
  makeDocId,
  getDb,
} from '../services/doc-store.js';
import { tokenize } from '../services/tokenizer.js';
import type { UpsertDocInput } from '../types.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token';

function verifyAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_TOKEN}`) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function adminRoutes(fastify: FastifyInstance) {
  // 单篇文档写入
  fastify.post('/admin/upsert', async (request, reply) => {
    if (!verifyAdmin(request, reply)) return;

    const body = request.body as {
      source: string;
      source_name?: string;
      path: string;
      title: string;
      content: string;
      api_path?: string;
      dev_mode?: string;
      doc_type?: string;
      source_url?: string;
      metadata?: Record<string, unknown>;
      last_updated?: string;
      error_codes?: Array<{ code: string; message?: string; description?: string }>;
    };

    if (!body.source || !body.path || !body.title || !body.content) {
      reply.code(400);
      return { error: 'Missing required fields: source, path, title, content' };
    }

    // 确保 source 存在
    if (body.source_name) {
      upsertSource(body.source, body.source_name);
    }

    const doc: UpsertDocInput = {
      source_id: body.source,
      path: body.path,
      title: body.title,
      content: body.content,
      api_path: body.api_path,
      dev_mode: body.dev_mode,
      doc_type: body.doc_type,
      source_url: body.source_url,
      metadata: body.metadata,
      last_updated: body.last_updated,
      tokenized_title: tokenize(body.title),
      tokenized_content: tokenize(body.content),
    };

    const result = upsertDocument(doc);

    // 写入错误码
    if (body.error_codes?.length) {
      const codes = body.error_codes.map((ec) => ({
        source_id: body.source,
        code: ec.code,
        message: ec.message,
        description: ec.description,
        doc_id: result.doc_id,
      }));
      upsertErrorCodes(body.source, codes);
    }

    return result;
  });

  // 批量写入
  fastify.post('/admin/bulk-upsert', async (request, reply) => {
    if (!verifyAdmin(request, reply)) return;

    const body = request.body as {
      source: string;
      source_name?: string;
      documents: Array<{
        path: string;
        title: string;
        content: string;
        api_path?: string;
        dev_mode?: string;
        doc_type?: string;
        source_url?: string;
        metadata?: Record<string, unknown>;
        last_updated?: string;
        error_codes?: Array<{ code: string; message?: string; description?: string }>;
      }>;
    };

    if (!body.source || !body.documents || !Array.isArray(body.documents)) {
      reply.code(400);
      return { error: 'Missing required fields: source, documents' };
    }

    if (body.source_name) {
      upsertSource(body.source, body.source_name);
    }

    const docs: UpsertDocInput[] = body.documents.map((d) => ({
      source_id: body.source,
      path: d.path,
      title: d.title,
      content: d.content,
      api_path: d.api_path,
      dev_mode: d.dev_mode,
      doc_type: d.doc_type,
      source_url: d.source_url,
      metadata: d.metadata,
      last_updated: d.last_updated,
      tokenized_title: tokenize(d.title),
      tokenized_content: tokenize(d.content),
    }));

    const result = bulkUpsert(body.source, docs);

    // 写入错误码
    const allCodes: Array<{ source_id: string; code: string; message?: string; description?: string; doc_id?: string }> = [];
    for (const d of body.documents) {
      if (d.error_codes?.length) {
        const docId = makeDocId(body.source, d.path);
        for (const ec of d.error_codes) {
          allCodes.push({
            source_id: body.source,
            code: ec.code,
            message: ec.message,
            description: ec.description,
            doc_id: docId,
          });
        }
      }
    }
    if (allCodes.length > 0) {
      upsertErrorCodes(body.source, allCodes);
    }

    return result;
  });

  // 删除文档
  fastify.delete('/admin/doc/:docId', async (request, reply) => {
    if (!verifyAdmin(request, reply)) return;

    const { docId } = request.params as { docId: string };
    const deleted = deleteDocument(docId);
    return { deleted };
  });

  // 重建 FTS 索引
  fastify.post('/admin/reindex', async (request, reply) => {
    if (!verifyAdmin(request, reply)) return;

    const db = getDb();

    // 删除 FTS 内容，重新插入
    db.exec("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')");

    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM documents').get() as { cnt: number }
    ).cnt;

    return { reindexed: count };
  });
}
