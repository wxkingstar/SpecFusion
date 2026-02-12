import PQueue from 'p-queue';
import axios, { type AxiosInstance } from 'axios';
import type { DocSource, DocEntry, DocContent, SyncOptions, SyncResult } from './types.js';
import { FeishuSource } from './sources/feishu.js';
import { WecomSource } from './sources/wecom.js';
import { OpenAPISource } from './sources/openapi.js';

// ── 默认值 ──────────────────────────────────────────────────────────────

const DEFAULT_API_URL = 'http://localhost:3456/api';
const DEFAULT_ADMIN_TOKEN = 'dev-token';
const DEFAULT_CONCURRENCY = 6;
const BATCH_SIZE = 50;

// ── Source 注册表 ────────────────────────────────────────────────────────

interface SourceFactory {
  create(config?: Record<string, unknown>): DocSource;
}

const SOURCE_REGISTRY: Record<string, SourceFactory> = {
  feishu: { create: () => new FeishuSource() },
  wecom: { create: () => new WecomSource() },
};

export function registerOpenAPISource(
  id: string,
  name: string,
  specUrl: string,
): void {
  SOURCE_REGISTRY[id] = {
    create: () => new OpenAPISource(specUrl, id, name),
  };
}

export function createSource(sourceId: string): DocSource {
  const factory = SOURCE_REGISTRY[sourceId];
  if (!factory) {
    throw new Error(
      `未知文档源: ${sourceId}。可用: ${Object.keys(SOURCE_REGISTRY).join(', ')}`,
    );
  }
  return factory.create();
}

export function listRegisteredSources(): string[] {
  return Object.keys(SOURCE_REGISTRY);
}

// ── HTTP 客户端 ──────────────────────────────────────────────────────────

function createApiClient(apiUrl: string, adminToken: string): AxiosInstance {
  return axios.create({
    baseURL: apiUrl,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 60_000,
  });
}

// ── 批量推送 ─────────────────────────────────────────────────────────────

interface PendingDoc {
  path: string;
  title: string;
  content: string;
  api_path?: string;
  dev_mode?: string;
  doc_type?: string;
  source_url?: string;
  metadata?: Record<string, unknown>;
  last_updated?: string;
}

async function flushBatch(
  client: AxiosInstance,
  sourceId: string,
  sourceName: string,
  docs: PendingDoc[],
  result: SyncResult,
): Promise<void> {
  if (docs.length === 0) return;
  try {
    const resp = await client.post('/admin/bulk-upsert', {
      source: sourceId,
      source_name: sourceName,
      documents: docs,
    });
    const data = resp.data as { created: number; updated: number; unchanged: number };
    result.created += data.created ?? 0;
    result.updated += data.updated ?? 0;
    result.unchanged += data.unchanged ?? 0;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[sync] 批量推送失败 (${docs.length} 篇): ${msg}`);
    result.errors += docs.length;
  }
}

// ── 核心同步函数 ──────────────────────────────────────────────────────────

export async function syncSource(
  sourceId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const apiUrl = options.apiUrl || process.env.SPECFUSION_API_URL || DEFAULT_API_URL;
  const adminToken = options.adminToken || process.env.ADMIN_TOKEN || DEFAULT_ADMIN_TOKEN;
  const limit = options.limit;
  const concurrency = DEFAULT_CONCURRENCY;

  const startTime = Date.now();
  const result: SyncResult = {
    source: sourceId,
    created: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    errors: 0,
    duration: 0,
  };

  const source = createSource(sourceId);
  const client = createApiClient(apiUrl, adminToken);

  console.log(`[sync] 开始同步 ${source.name} (${source.id}) ...`);

  // 1. 获取文档目录
  let entries: DocEntry[];
  if (options.incremental) {
    console.log('[sync] 增量模式：检测变更...');
    const since = new Date(Date.now() - 7 * 24 * 3600_000); // 默认 7 天
    entries = await source.detectUpdates(since);
  } else {
    console.log('[sync] 全量模式：获取完整目录...');
    entries = await source.fetchCatalog();
  }

  if (limit && limit > 0) {
    entries = entries.slice(0, limit);
    console.log(`[sync] 限制处理数量: ${limit}`);
  }

  const totalEntries = entries.length;
  console.log(`[sync] 发现 ${totalEntries} 篇文档`);

  if (totalEntries === 0) {
    result.duration = Date.now() - startTime;
    console.log('[sync] 无文档需要同步');
    return result;
  }

  // 2. 并发获取内容并批量推送
  const queue = new PQueue({ concurrency });
  const pendingDocs: PendingDoc[] = [];
  let processedCount = 0;
  let lastProgressLog = 0;

  const flushPending = async () => {
    if (pendingDocs.length > 0) {
      const batch = pendingDocs.splice(0, pendingDocs.length);
      await flushBatch(client, source.id, source.name, batch, result);
    }
  };

  for (const entry of entries) {
    queue.add(async () => {
      try {
        const content: DocContent = await source.fetchContent(entry);

        const doc: PendingDoc = {
          path: entry.path,
          title: entry.title,
          content: content.markdown,
          api_path: content.apiPath || entry.apiPath,
          dev_mode: entry.devMode,
          doc_type: entry.docType,
          source_url: entry.sourceUrl,
          metadata: content.metadata,
          last_updated: entry.lastUpdated,
        };

        pendingDocs.push(doc);

        // 达到批次大小时推送
        if (pendingDocs.length >= BATCH_SIZE) {
          await flushPending();
        }
      } catch (error: unknown) {
        result.errors++;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[sync] 获取文档失败: ${entry.title} — ${msg}`);
      }

      processedCount++;
      // 每 100 篇或进度 10% 输出日志
      const progressInterval = Math.max(100, Math.floor(totalEntries / 10));
      if (processedCount - lastProgressLog >= progressInterval) {
        lastProgressLog = processedCount;
        const pct = ((processedCount / totalEntries) * 100).toFixed(1);
        console.log(`[sync] 进度: ${processedCount}/${totalEntries} (${pct}%)`);
      }
    });
  }

  await queue.onIdle();

  // 3. 推送剩余文档
  await flushPending();

  result.duration = Date.now() - startTime;

  // 4. 输出结果摘要
  console.log('');
  console.log(`[sync] ✓ 同步完成: ${source.name}`);
  console.log(`  新增: ${result.created}`);
  console.log(`  更新: ${result.updated}`);
  console.log(`  未变: ${result.unchanged}`);
  console.log(`  错误: ${result.errors}`);
  console.log(`  耗时: ${(result.duration / 1000).toFixed(1)}s`);

  return result;
}

// ── 同步所有源 ───────────────────────────────────────────────────────────

export async function syncAll(
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  const sourceIds = listRegisteredSources();
  const results: SyncResult[] = [];

  console.log(`[sync] 开始全量同步，共 ${sourceIds.length} 个源: ${sourceIds.join(', ')}`);

  for (const sourceId of sourceIds) {
    try {
      const result = await syncSource(sourceId, options);
      results.push(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[sync] 源 ${sourceId} 同步失败: ${msg}`);
      results.push({
        source: sourceId,
        created: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
        errors: 1,
        duration: 0,
      });
    }
  }

  // 汇总
  const totals = results.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      unchanged: acc.unchanged + r.unchanged,
      errors: acc.errors + r.errors,
    }),
    { created: 0, updated: 0, unchanged: 0, errors: 0 },
  );

  console.log('');
  console.log('[sync] ═══ 全量同步汇总 ═══');
  console.log(`  新增: ${totals.created}`);
  console.log(`  更新: ${totals.updated}`);
  console.log(`  未变: ${totals.unchanged}`);
  console.log(`  错误: ${totals.errors}`);

  return results;
}
