#!/usr/bin/env node
/**
 * WP Replica Factory – Domain Downloader CLI
 *
 * 最简启动命令：只需填域名即可启动整站下载。
 *
 * Usage:
 *   node tools/dl/cli.mjs start <domain>            # 新建任务
 *   node tools/dl/cli.mjs resume <outputDir>         # 恢复已暂停任务
 *   node tools/dl/cli.mjs ui [--port 7832]           # 启动本地管理界面
 *   node tools/dl/cli.mjs status <outputDir>         # 查看任务状态
 *
 * Options:
 *   --out <dir>         输出目录（默认: .replica/dl/<domain>-<timestamp>）
 *   --storage <dir>     Crawlee队列存储目录（默认: .replica/dl-storage/<runId>）
 *   --port <n>          UI服务端口（默认: 7832）
 *   --max-pages <n>     最大页数（默认: 0=整站无限制）
 *   --timeout <ms>      每页超时（默认: 45000）
 *   --help
 *
 * Requirements:
 *   npm ci --prefix tools/downloader (for Playwright + Crawlee)
 *   $env:PLAYWRIGHT_BROWSERS_PATH = ".replica/browsers"
 *   node tools/downloader/node_modules/playwright/cli.js install chromium
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const USAGE = `
WP Replica Factory – 域名下载器 (E-DL)

USAGE
  node tools/dl/cli.mjs start <domain>         新建整站下载
  node tools/dl/cli.mjs resume <outputDir>     恢复已暂停任务
  node tools/dl/cli.mjs ui                     启动本地管理界面
  node tools/dl/cli.mjs status <outputDir>     查看任务状态

OPTIONS
  --out <dir>         输出目录（默认: .replica/dl/<domain>-<timestamp>）
  --storage <dir>     队列存储目录（默认: .replica/dl-storage/<id>）
  --port <n>          UI端口（默认: 7832）
  --max-pages <n>     最大页数，0=无限（默认: 0）
  --timeout <ms>      每页超时毫秒（默认: 45000）

EXAMPLE
  node tools/dl/cli.mjs start reebelo.com
  node tools/dl/cli.mjs ui --port 7832
  node tools/dl/cli.mjs resume .replica/dl/reebelo.com-abc12345
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      out:         { type: 'string' },
      storage:     { type: 'string' },
      port:        { type: 'string', default: '7832' },
      'max-pages': { type: 'string', default: '0' },
      timeout:     { type: 'string', default: '45000' },
    },
    allowPositionals: true,
    strict: false,
  });

  const port = parseInt(values.port) || 7832;
  const maxPages = parseInt(values['max-pages']) || 0;
  const pageTimeoutMs = parseInt(values.timeout) || 45000;

  // ── ui ──────────────────────────────────────────────────────────────────
  if (command === 'ui') {
    const { startUIServer, registerRun, scanOutputDir } = await import('./ui-server.mjs');
    const { CrawlRun, runCrawl, resumeCrawl, loadRunState } = await import('./crawl-manager.mjs');

    const baseOutputDir = path.resolve(ROOT, '.replica/dl');
    const baseStorageDir = path.resolve(ROOT, '.replica/dl-storage');

    // Load any existing checkpointed runs into registry at startup
    const existingRuns = scanOutputDir(baseOutputDir);
    console.log('[dl] Found ' + existingRuns.length + ' existing run(s) on disk.');

    const server = await startUIServer({
      baseOutputDir: baseOutputDir,
      baseStorageDir: baseStorageDir,
      port: port,
      onNewRun: async function(opts) {
        const run = new CrawlRun({
          runId: opts.runId,
          domain: opts.domain,
          outputDir: opts.outputDir,
          storageDir: opts.storageDir,
          config: {
            maxPages: opts.config.maxPages || maxPages,
            pageTimeoutMs: opts.config.pageTimeoutMs || pageTimeoutMs,
          },
        });
        registerRun(run);
        try {
          await runCrawl(run, {
            onProgress: function(r, url, result) {
              const saved = r.stats.saved;
              const queued = r.stats.queued;
              const failed = r.stats.failed;
              process.stdout.write('\r[dl] ' + r.domain + ' | saved:' + saved + ' queued:' + queued + ' failed:' + failed + '   ');
            },
          });
          console.log('\n[dl] Run ' + run.runId + ' finished with status: ' + run.status);
        } catch (e) {
          console.error('\n[dl] Run error:', e.message);
        }
      },
      onResumeRun: async function(outputDir, storageDir) {
        try {
          const state = loadRunState(outputDir);
          if (!state) { console.error('[dl] No checkpoint in', outputDir); return; }
          const run = new CrawlRun({
            runId: state.runId,
            domain: state.domain,
            outputDir: outputDir,
            storageDir: storageDir,
            config: state.config,
          });
          run.status = state.status;
          run.startedAt = state.startedAt;
          run.stats = Object.assign({}, run.stats, state.stats);
          run.assetOrigins = state.assetOrigins || [];

          const { loadPageIndex } = await import('./crawl-manager.mjs');
          const idx = loadPageIndex(outputDir);
          if (idx) run._pageIndex = { pages: idx.pages || {} };

          registerRun(run);
          await runCrawl(run, {
            onProgress: function(r, url, result) {
              const saved = r.stats.saved;
              const queued = r.stats.queued;
              process.stdout.write('\r[dl] ' + r.domain + ' | saved:' + saved + ' queued:' + queued + '   ');
            },
          });
          console.log('\n[dl] Resumed run finished: ' + run.status);
        } catch (e) {
          console.error('\n[dl] Resume error:', e.message);
        }
      },
    });

    console.log('\n✨ 下载管理器已启动');
    console.log('   UI地址: ' + server.origin);
    console.log('   输出目录: ' + baseOutputDir);
    console.log('   按 Ctrl+C 停止服务\n');

    // Graceful shutdown
    let stopping = false;
    async function stop() {
      if (stopping) return;
      stopping = true;
      console.log('\n[dl] 正在安全停止...');
      await server.close();
      process.exit(0);
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return; // keep running
  }

  // ── start ────────────────────────────────────────────────────────────────
  if (command === 'start') {
    const rawDomain = (positionals[0] || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!rawDomain) {
      console.error('Error: domain required. Example: node tools/dl/cli.mjs start reebelo.com');
      process.exit(1);
    }

    const { CrawlRun, runCrawl } = await import('./crawl-manager.mjs');

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const outputDir = values.out
      ? path.resolve(values.out)
      : path.resolve(ROOT, '.replica/dl', rawDomain + '-' + timestamp);

    const runId = crypto.randomUUID ? crypto.randomUUID() : require('node:crypto').randomUUID();
    const storageDir = values.storage
      ? path.resolve(values.storage)
      : path.resolve(ROOT, '.replica/dl-storage', runId);

    const run = new CrawlRun({
      domain: rawDomain,
      outputDir: outputDir,
      storageDir: storageDir,
      config: { maxPages: maxPages, pageTimeoutMs: pageTimeoutMs },
    });

    console.log('\n[dl] Starting crawl');
    console.log('   Domain   : ' + rawDomain);
    console.log('   Output   : ' + outputDir);
    console.log('   Max pages: ' + (maxPages || 'unlimited'));
    console.log('\nPress Ctrl+C to pause (state is preserved for resume)\n');

    let stopping = false;
    process.on('SIGINT', function() {
      if (stopping) return;
      stopping = true;
      run._pausing = true;
      console.log('\n[dl] Pause signal received – finishing current page...');
    });

    try {
      await runCrawl(run, {
        onProgress: function(r, url, result) {
          const saved = r.stats.saved;
          const queued = r.stats.queued;
          const failed = r.stats.failed;
          process.stdout.write('\r  saved:' + saved + ' queued:' + queued + ' failed:' + failed + '   ');
        },
      });
      console.log('\n\n[dl] Done. Status: ' + run.status);
      console.log('   Saved     : ' + run.stats.saved + ' pages');
      console.log('   Failed    : ' + run.stats.failed);
      console.log('   Output    : ' + outputDir);
      console.log('\nTo resume: node tools/dl/cli.mjs resume ' + outputDir);
    } catch (e) {
      console.error('\n[dl] Error:', e.message);
      process.exit(1);
    }
    return;
  }

  // ── resume ───────────────────────────────────────────────────────────────
  if (command === 'resume') {
    const outputDir = path.resolve(positionals[0] || '');
    if (!outputDir || !fs.existsSync(outputDir)) {
      console.error('Error: valid outputDir required');
      process.exit(1);
    }
    const { resumeCrawl, loadRunState } = await import('./crawl-manager.mjs');
    const state = loadRunState(outputDir);
    if (!state) { console.error('No checkpoint found in', outputDir); process.exit(1); }

    const storageDir = values.storage
      ? path.resolve(values.storage)
      : path.resolve(ROOT, '.replica/dl-storage', state.runId);

    console.log('\n[dl] Resuming crawl: ' + state.domain);
    console.log('   Output: ' + outputDir);
    console.log('   Previously saved: ' + (state.stats && state.stats.saved || 0) + ' pages\n');

    process.on('SIGINT', function() {
      console.log('\n[dl] Pause signal – finishing current page...');
    });

    const { CrawlRun, runCrawl, loadPageIndex } = await import('./crawl-manager.mjs');
    const run = new CrawlRun({
      runId: state.runId,
      domain: state.domain,
      outputDir: outputDir,
      storageDir: storageDir,
      config: state.config,
    });
    run.status = state.status;
    run.startedAt = state.startedAt;
    run.stats = Object.assign({}, run.stats, state.stats);
    run.assetOrigins = state.assetOrigins || [];
    const idx = loadPageIndex(outputDir);
    if (idx) run._pageIndex = { pages: idx.pages || {} };

    process.on('SIGINT', function() { run._pausing = true; });

    await runCrawl(run, {
      onProgress: function(r) {
        process.stdout.write('\r  saved:' + r.stats.saved + ' queued:' + r.stats.queued + ' failed:' + r.stats.failed + '   ');
      },
    });

    console.log('\n[dl] Done. Status: ' + run.status);
    console.log('   Saved: ' + run.stats.saved + ' pages');
    return;
  }

  // ── status ───────────────────────────────────────────────────────────────
  if (command === 'status') {
    const outputDir = path.resolve(positionals[0] || '');
    const { loadRunState, loadPageIndex } = await import('./crawl-manager.mjs');
    const state = loadRunState(outputDir);
    if (!state) { console.error('No checkpoint found in', outputDir); process.exit(1); }
    const idx = loadPageIndex(outputDir);
    const pages = idx ? idx.pages : {};
    const total = Object.keys(pages).length;
    const saved = Object.values(pages).filter(function(p) { return p.status === 'saved'; }).length;
    const queued = Object.values(pages).filter(function(p) { return p.status === 'queued'; }).length;
    const failed = Object.values(pages).filter(function(p) { return p.status === 'failed' || p.status === 'blocked'; }).length;

    console.log('\nRun status: ' + state.domain);
    console.log('  runId  : ' + state.runId);
    console.log('  status : ' + state.status);
    console.log('  started: ' + state.startedAt);
    console.log('  pages  : ' + total + ' total, ' + saved + ' saved, ' + queued + ' queued, ' + failed + ' failed');
    console.log('  output : ' + outputDir);
    if (state.status === 'paused' || state.status === 'blocked') {
      console.log('\nTo resume: node tools/dl/cli.mjs resume ' + outputDir);
    }
    return;
  }

  console.error('Unknown command: ' + command + '\n\n' + USAGE);
  process.exit(1);
}

// Need crypto for start command
import crypto from 'node:crypto';

main().catch(function(e) {
  console.error('[dl] Fatal:', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
