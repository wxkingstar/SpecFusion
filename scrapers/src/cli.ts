#!/usr/bin/env node
import { Command } from 'commander';
import { syncSource, syncAll, listRegisteredSources, registerOpenAPISource } from './sync.js';
import type { SyncOptions } from './types.js';

const program = new Command();

program
  .name('specfusion')
  .description('SpecFusion 文档抓取与同步工具')
  .version('0.1.0');

// ── sync 命令 ────────────────────────────────────────────────────────────

program
  .command('sync [source]')
  .description('同步指定文档源（不指定则同步全部）')
  .option('--all', '同步所有已注册文档源')
  .option('-i, --incremental', '增量同步（仅获取变更文档）')
  .option('-l, --limit <number>', '限制处理文档数量（调试用）', parseInt)
  .option('--api-url <url>', 'API 服务地址', process.env.SPECFUSION_API_URL || 'http://localhost:3456/api')
  .option('--admin-token <token>', 'Admin Token', process.env.ADMIN_TOKEN || 'dev-token')
  .action(async (source: string | undefined, opts: {
    all?: boolean;
    incremental?: boolean;
    limit?: number;
    apiUrl?: string;
    adminToken?: string;
  }) => {
    const syncOpts: SyncOptions = {
      incremental: opts.incremental,
      limit: opts.limit,
      apiUrl: opts.apiUrl,
      adminToken: opts.adminToken,
    };

    try {
      if (opts.all || !source) {
        const results = await syncAll(syncOpts);
        const hasErrors = results.some((r) => r.errors > 0);
        process.exitCode = hasErrors ? 1 : 0;
      } else {
        const result = await syncSource(source, syncOpts);
        process.exitCode = result.errors > 0 ? 1 : 0;
      }
    } catch (error) {
      console.error('同步失败:', (error as Error).message);
      process.exitCode = 1;
    }
  });

// ── list-sources 命令 ────────────────────────────────────────────────────

program
  .command('list-sources')
  .description('列出所有已注册的文档源')
  .action(() => {
    const sources = listRegisteredSources();
    console.log('已注册文档源:');
    for (const id of sources) {
      console.log(`  - ${id}`);
    }
  });

// ── add-openapi 命令 ────────────────────────────────────────────────────

program
  .command('add-openapi <id>')
  .description('注册一个 OpenAPI 文档源')
  .requiredOption('-n, --name <name>', '文档源显示名称')
  .requiredOption('-u, --spec-url <url>', 'OpenAPI spec 文件地址（JSON/YAML）')
  .option('--sync', '注册后立即同步')
  .option('--api-url <url>', 'API 服务地址', process.env.SPECFUSION_API_URL || 'http://localhost:3456/api')
  .option('--admin-token <token>', 'Admin Token', process.env.ADMIN_TOKEN || 'dev-token')
  .action(async (id: string, opts: {
    name: string;
    specUrl: string;
    sync?: boolean;
    apiUrl?: string;
    adminToken?: string;
  }) => {
    registerOpenAPISource(id, opts.name, opts.specUrl);
    console.log(`已注册 OpenAPI 源: ${id} (${opts.name})`);
    console.log(`  Spec URL: ${opts.specUrl}`);

    if (opts.sync) {
      try {
        await syncSource(id, {
          apiUrl: opts.apiUrl,
          adminToken: opts.adminToken,
        });
      } catch (error) {
        console.error('同步失败:', (error as Error).message);
        process.exitCode = 1;
      }
    }
  });

program.parse();
