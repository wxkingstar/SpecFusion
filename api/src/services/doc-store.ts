import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type {
  Document,
  Source,
  ErrorCode,
  SyncLog,
  UpsertDocInput,
  BulkUpsertResult,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

export function makeDocId(sourceId: string, path: string): string {
  const hash = sha256(path).slice(0, 12);
  return `${sourceId}_${hash}`;
}

// ---------------------------------------------------------------------------
// Database init
// ---------------------------------------------------------------------------

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  db = new Database(resolve(dbPath));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = resolve(__dirname, '../../db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// ---------------------------------------------------------------------------
// Document CRUD
// ---------------------------------------------------------------------------

export function upsertDocument(
  doc: UpsertDocInput,
): { doc_id: string; action: 'created' | 'updated' | 'unchanged' } {
  const d = getDb();
  const docId = makeDocId(doc.source_id, doc.path);
  const contentHash = sha256(doc.content);
  const ts = now();
  const metadata = doc.metadata ? JSON.stringify(doc.metadata) : null;
  const pathDepth = doc.path.split('/').filter(Boolean).length || 1;

  const existing = d
    .prepare('SELECT content_hash FROM documents WHERE id = ?')
    .get(docId) as { content_hash: string } | undefined;

  if (existing) {
    if (existing.content_hash === contentHash) {
      return { doc_id: docId, action: 'unchanged' };
    }
    d.prepare(
      `UPDATE documents SET
        title = ?, content = ?, content_hash = ?, prev_content_hash = ?,
        api_path = ?, dev_mode = ?, doc_type = ?, source_url = ?,
        metadata = ?, tokenized_title = ?, tokenized_content = ?,
        last_updated = ?, synced_at = ?, path_depth = ?
      WHERE id = ?`,
    ).run(
      doc.title, doc.content, contentHash, existing.content_hash,
      doc.api_path ?? null, doc.dev_mode ?? null, doc.doc_type ?? 'api_reference',
      doc.source_url ?? null, metadata,
      doc.tokenized_title ?? null, doc.tokenized_content ?? null,
      doc.last_updated ?? ts, ts, pathDepth,
      docId,
    );
    return { doc_id: docId, action: 'updated' };
  }

  d.prepare(
    `INSERT INTO documents (
      id, source_id, path, path_depth, title, api_path, dev_mode, doc_type,
      content, content_hash, prev_content_hash, source_url, metadata,
      tokenized_title, tokenized_content, last_updated, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    docId, doc.source_id, doc.path, pathDepth, doc.title,
    doc.api_path ?? null, doc.dev_mode ?? null, doc.doc_type ?? 'api_reference',
    doc.content, contentHash, doc.source_url ?? null, metadata,
    doc.tokenized_title ?? null, doc.tokenized_content ?? null,
    doc.last_updated ?? ts, ts,
  );
  return { doc_id: docId, action: 'created' };
}

export function bulkUpsert(source: string, documents: UpsertDocInput[]): BulkUpsertResult {
  const d = getDb();
  const result: BulkUpsertResult = { created: 0, updated: 0, unchanged: 0 };

  const selectStmt = d.prepare('SELECT content_hash FROM documents WHERE id = ?');
  const insertStmt = d.prepare(
    `INSERT INTO documents (
      id, source_id, path, path_depth, title, api_path, dev_mode, doc_type,
      content, content_hash, prev_content_hash, source_url, metadata,
      tokenized_title, tokenized_content, last_updated, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStmt = d.prepare(
    `UPDATE documents SET
      title = ?, content = ?, content_hash = ?, prev_content_hash = ?,
      api_path = ?, dev_mode = ?, doc_type = ?, source_url = ?,
      metadata = ?, tokenized_title = ?, tokenized_content = ?,
      last_updated = ?, synced_at = ?, path_depth = ?
    WHERE id = ?`,
  );

  const runBulk = d.transaction(() => {
    const ts = now();
    for (const doc of documents) {
      const docId = makeDocId(doc.source_id, doc.path);
      const contentHash = sha256(doc.content);
      const metadata = doc.metadata ? JSON.stringify(doc.metadata) : null;
      const pathDepth = doc.path.split('/').filter(Boolean).length || 1;

      const existing = selectStmt.get(docId) as { content_hash: string } | undefined;

      if (existing) {
        if (existing.content_hash === contentHash) {
          result.unchanged++;
          continue;
        }
        updateStmt.run(
          doc.title, doc.content, contentHash, existing.content_hash,
          doc.api_path ?? null, doc.dev_mode ?? null, doc.doc_type ?? 'api_reference',
          doc.source_url ?? null, metadata,
          doc.tokenized_title ?? null, doc.tokenized_content ?? null,
          doc.last_updated ?? ts, ts, pathDepth,
          docId,
        );
        result.updated++;
      } else {
        insertStmt.run(
          docId, doc.source_id, doc.path, pathDepth, doc.title,
          doc.api_path ?? null, doc.dev_mode ?? null, doc.doc_type ?? 'api_reference',
          doc.content, contentHash, doc.source_url ?? null, metadata,
          doc.tokenized_title ?? null, doc.tokenized_content ?? null,
          doc.last_updated ?? ts, ts,
        );
        result.created++;
      }
    }

    // Update source doc_count
    const countRow = d
      .prepare('SELECT COUNT(*) as cnt FROM documents WHERE source_id = ?')
      .get(source) as { cnt: number };
    d.prepare('UPDATE sources SET doc_count = ? WHERE id = ?').run(countRow.cnt, source);
  });

  runBulk();
  return result;
}

export function getDocument(docId: string): Document | null {
  const row = getDb()
    .prepare('SELECT * FROM documents WHERE id = ?')
    .get(docId) as Document | undefined;
  return row ?? null;
}

export function deleteDocument(docId: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM documents WHERE id = ?')
    .run(docId);
  return info.changes > 0;
}

export function getDocumentsBySource(sourceId: string): Document[] {
  return getDb()
    .prepare('SELECT * FROM documents WHERE source_id = ?')
    .all(sourceId) as Document[];
}

// ---------------------------------------------------------------------------
// Source management
// ---------------------------------------------------------------------------

export function upsertSource(id: string, name: string, baseUrl?: string): void {
  getDb()
    .prepare(
      `INSERT INTO sources (id, name, base_url)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url`,
    )
    .run(id, name, baseUrl ?? null);
}

export function getSources(): Source[] {
  return getDb().prepare('SELECT * FROM sources').all() as Source[];
}

export function updateSourceSyncTime(sourceId: string): void {
  getDb()
    .prepare('UPDATE sources SET last_synced = ? WHERE id = ?')
    .run(now(), sourceId);
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export function upsertErrorCodes(sourceId: string, codes: ErrorCode[]): void {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO error_codes (source_id, code, message, description, doc_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_id, code) DO UPDATE SET
       message = excluded.message,
       description = excluded.description,
       doc_id = excluded.doc_id`,
  );

  const runBatch = d.transaction(() => {
    for (const ec of codes) {
      stmt.run(
        sourceId,
        ec.code,
        ec.message ?? null,
        ec.description ?? null,
        ec.doc_id ?? null,
      );
    }
  });

  runBatch();
}

export function findErrorCode(code: string): ErrorCode | null {
  const row = getDb()
    .prepare('SELECT * FROM error_codes WHERE code = ?')
    .get(code) as ErrorCode | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

export function createSyncLog(sourceId: string): number {
  const info = getDb()
    .prepare(
      `INSERT INTO sync_log (source_id, started_at, status)
       VALUES (?, ?, 'running')`,
    )
    .run(sourceId, now());
  return Number(info.lastInsertRowid);
}

export function updateSyncLog(
  id: number,
  status: string,
  stats: Partial<SyncLog>,
): void {
  const d = getDb();
  const fields: string[] = ['status = ?', 'finished_at = ?'];
  const values: unknown[] = [status, now()];

  if (stats.created !== undefined) {
    fields.push('created = ?');
    values.push(stats.created);
  }
  if (stats.updated !== undefined) {
    fields.push('updated = ?');
    values.push(stats.updated);
  }
  if (stats.unchanged !== undefined) {
    fields.push('unchanged = ?');
    values.push(stats.unchanged);
  }
  if (stats.deleted !== undefined) {
    fields.push('deleted = ?');
    values.push(stats.deleted);
  }
  if (stats.error !== undefined) {
    fields.push('error = ?');
    values.push(stats.error);
  }

  values.push(id);
  d.prepare(`UPDATE sync_log SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// ---------------------------------------------------------------------------
// Search log
// ---------------------------------------------------------------------------

export function logSearch(
  query: string,
  source: string | undefined,
  resultCount: number,
  topScore: number | undefined,
  tookMs: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO search_log (query, source, result_count, top_score, took_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(query, source ?? null, resultCount, topScore ?? null, tookMs, now());
}
