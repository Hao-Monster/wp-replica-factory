/**
 * WP Replica Factory – Local UI Server
 *
 * 本地Web管理界面（仅绑定 127.0.0.1）：
 * - GET /              → 管理UI（HTML）
 * - GET /api/runs      → 任务列表
 * - POST /api/runs     → 新建任务（body: {domain}）
 * - GET /api/runs/:id  → 任务状态+页面明细
 * - POST /api/runs/:id/pause  → 暂停
 * - POST /api/runs/:id/resume → 继续
 * - GET /api/runs/:id/pages/:pageId → 查看保存的HTML（通过安全路径映射）
 *
 * 安全边界：
 * - 仅 127.0.0.1，拒绝其他 Host
 * - 预览HTML通过沙盒iframe + CSP隔离
 * - 不暴露仓库根目录，不代理源站
 * - 不执行GET以外的任何外部请求
 *
 * @module ui-server
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-memory run registry (keyed by runId)
const runRegistry = new Map();

// ─── Route registry ───────────────────────────────────────────────────────

/**
 * Register an active CrawlRun instance in the registry.
 */
export function registerRun(run) {
  runRegistry.set(run.runId, run);
}

/**
 * Get all registered runs.
 */
export function getRegisteredRuns() {
  return [...runRegistry.values()];
}

// ─── Output directory scanning ───────────────────────────────────────────

/**
 * Scan a base output directory for existing crawl runs (checkpoint files).
 */
export function scanOutputDir(baseOutputDir) {
  const runs = [];
  if (!fs.existsSync(baseOutputDir)) return runs;
  for (const entry of fs.readdirSync(baseOutputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cpPath = path.join(baseOutputDir, entry.name, '.crawl-checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try {
        const state = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        runs.push({ ...state, outputDir: path.join(baseOutputDir, entry.name) });
      } catch { /* skip corrupt checkpoints */ }
    }
  }
  return runs;
}

// ─── Security helpers ─────────────────────────────────────────────────────

function safeHost(req, port) {
  const host = req.headers['host'] || '';
  return host === '127.0.0.1:' + port || host === 'localhost:' + port;
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendUI(res) {
  const uiPath = path.join(__dirname, 'ui.html');
  if (!fs.existsSync(uiPath)) {
    res.writeHead(404);
    res.end('UI not found');
    return;
  }
  const html = fs.readFileSync(uiPath);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; worker-src 'none'; form-action 'self';",
  });
  res.end(html);
}

// ─── Captured HTML viewer ─────────────────────────────────────────────────

/**
 * Serve a captured HTML file through a sandboxed frame.
 * The HTML is served with strict CSP that blocks all external connections.
 * Path must stay within the run's outputDir.
 */
function serveCapturePage(res, runOutputDir, relHtmlPath) {
  // Resolve and validate path stays within outputDir
  const absOutputDir = path.resolve(runOutputDir);
  const absHtmlPath = path.resolve(absOutputDir, relHtmlPath);
  if (!absHtmlPath.startsWith(absOutputDir + path.sep) && absHtmlPath !== absOutputDir) {
    res.writeHead(403);
    res.end('Path refused');
    return;
  }
  if (!fs.existsSync(absHtmlPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const body = fs.readFileSync(absHtmlPath);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Strict CSP for untrusted HTML preview: block all external connections
    'Content-Security-Policy':
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
      "connect-src 'none'; frame-ancestors 'self'; form-action 'none'; " +
      "img-src 'self' data: blob:; media-src 'self' data: blob:;",
    'X-Frame-Options': 'SAMEORIGIN',
  });
  res.end(body);
}

// ─── Request parsing ──────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(function(resolve, reject) {
    const chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── Server factory ───────────────────────────────────────────────────────

/**
 * Creates and starts the local UI server.
 *
 * @param {object} opts
 * @param {string}   opts.baseOutputDir  – base dir where runs are stored
 * @param {string}   opts.baseStorageDir – base dir for Crawlee queue storage
 * @param {number}   [opts.port]         – port to bind (default: 0 = auto)
 * @param {function} [opts.onNewRun]     – called with (run) when a new crawl starts
 * @param {function} [opts.onResumeRun]  – called with (run, outputDir) to resume
 * @returns {Promise<{origin: string, close: function}>}
 */
export async function startUIServer(opts) {
  const baseOutputDir = path.resolve(opts.baseOutputDir);
  const baseStorageDir = path.resolve(opts.baseStorageDir);
  const port = opts.port || 0;
  const onNewRun = opts.onNewRun || null;
  const onResumeRun = opts.onResumeRun || null;

  fs.mkdirSync(baseOutputDir, { recursive: true });
  fs.mkdirSync(baseStorageDir, { recursive: true });

  const server = http.createServer(async function(req, res) {
    // Security: host check
    if (!safeHost(req, server.address().port)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      // ── GET / → UI ──────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/') {
        sendUI(res);
        return;
      }

      // ── GET /api/runs → list all runs ────────────────────────────────
      if (method === 'GET' && pathname === '/api/runs') {
        const diskRuns = scanOutputDir(baseOutputDir);
        const active = [...runRegistry.values()].map(function(r) {
          return {
            runId: r.runId,
            domain: r.domain,
            status: r.status,
            startedAt: r.startedAt,
            stats: r.stats,
            outputDir: r.outputDir,
            active: true,
          };
        });
        const activeIds = new Set(active.map(function(r) { return r.runId; }));
        const disk = diskRuns
          .filter(function(d) { return !activeIds.has(d.runId); })
          .map(function(d) {
            return {
              runId: d.runId,
              domain: d.domain,
              status: d.status,
              startedAt: d.startedAt,
              stats: d.stats,
              outputDir: d.outputDir,
              active: false,
            };
          });
        jsonResponse(res, 200, { runs: active.concat(disk) });
        return;
      }

      // ── POST /api/runs → create new run ──────────────────────────────
      if (method === 'POST' && pathname === '/api/runs') {
        const body = await readBody(req);
        const domain = (body.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain)) {
          jsonResponse(res, 400, { error: 'Invalid domain' });
          return;
        }
        const runId = crypto.randomUUID();
        const runOutputDir = path.join(baseOutputDir, domain + '-' + runId.slice(0, 8));
        const runStorageDir = path.join(baseStorageDir, runId);
        const runConfig = {
          maxPages: body.maxPages || 0,
          pageTimeoutMs: body.pageTimeoutMs || 45000,
        };

        jsonResponse(res, 202, {
          runId: runId,
          domain: domain,
          outputDir: runOutputDir,
          message: 'Crawl starting',
        });

        // Start crawl asynchronously
        if (onNewRun) {
          process.nextTick(function() {
            onNewRun({ runId, domain, outputDir: runOutputDir, storageDir: runStorageDir, config: runConfig });
          });
        }
        return;
      }

      // ── GET /api/runs/:id → run status + page list ───────────────────
      const runMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
      if (method === 'GET' && runMatch) {
        const runId = runMatch[1];
        const activeRun = runRegistry.get(runId);

        if (activeRun) {
          const idx = activeRun._pageIndex || { pages: {} };
          jsonResponse(res, 200, {
            runId: activeRun.runId,
            domain: activeRun.domain,
            status: activeRun.status,
            startedAt: activeRun.startedAt,
            stats: activeRun.stats,
            outputDir: activeRun.outputDir,
            active: true,
            pages: idx.pages,
          });
          return;
        }

        // Try disk
        const diskRuns = scanOutputDir(baseOutputDir);
        const diskRun = diskRuns.find(function(r) { return r.runId === runId; });
        if (diskRun) {
          const idx = diskRun.outputDir
            ? tryReadJSON(path.join(diskRun.outputDir, 'crawl-index.json'))
            : null;
          jsonResponse(res, 200, {
            runId: diskRun.runId,
            domain: diskRun.domain,
            status: diskRun.status,
            startedAt: diskRun.startedAt,
            stats: diskRun.stats,
            outputDir: diskRun.outputDir,
            active: false,
            pages: (idx && idx.pages) || {},
          });
          return;
        }

        jsonResponse(res, 404, { error: 'Run not found' });
        return;
      }

      // ── POST /api/runs/:id/pause ────────────────────────────────────
      const pauseMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/pause$/);
      if (method === 'POST' && pauseMatch) {
        const runId = pauseMatch[1];
        const activeRun = runRegistry.get(runId);
        if (!activeRun) { jsonResponse(res, 404, { error: 'Run not found or not active' }); return; }
        activeRun._pausing = true;
        jsonResponse(res, 200, { status: 'pausing' });
        return;
      }

      // ── POST /api/runs/:id/resume ───────────────────────────────────
      const resumeMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/resume$/);
      if (method === 'POST' && resumeMatch) {
        const runId = resumeMatch[1];
        const activeRun = runRegistry.get(runId);
        if (activeRun && activeRun._running) {
          jsonResponse(res, 200, { status: 'already running' });
          return;
        }

        // Find the outputDir
        const diskRuns = scanOutputDir(baseOutputDir);
        const diskRun = diskRuns.find(function(r) { return r.runId === runId; });
        if (!diskRun) { jsonResponse(res, 404, { error: 'Run not found' }); return; }

        jsonResponse(res, 202, { status: 'resuming' });

        if (onResumeRun) {
          const runStorageDir = path.join(baseStorageDir, runId);
          process.nextTick(function() {
            onResumeRun(diskRun.outputDir, runStorageDir);
          });
        }
        return;
      }

      // ── GET /api/runs/:id/pages/:pageId → serve captured HTML ────────
      const pageMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/pages\/([a-zA-Z0-9]+)$/);
      if (method === 'GET' && pageMatch) {
        const runId = pageMatch[1];
        const pageId = pageMatch[2];

        // Find run outputDir
        let runOutputDir = null;
        const activeRun = runRegistry.get(runId);
        if (activeRun) {
          runOutputDir = activeRun.outputDir;
        } else {
          const diskRuns = scanOutputDir(baseOutputDir);
          const diskRun = diskRuns.find(function(r) { return r.runId === runId; });
          if (diskRun) runOutputDir = diskRun.outputDir;
        }
        if (!runOutputDir) { res.writeHead(404); res.end('Run not found'); return; }

        // pageId is the sha-based capture dir id (32 hex chars)
        const captureSubdir = path.join(runOutputDir, 'captures', pageId);
        const pagesDir = path.join(captureSubdir, 'pages');
        let htmlPath = null;

        if (fs.existsSync(pagesDir)) {
          for (const entry of fs.readdirSync(pagesDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const f = path.join(pagesDir, entry.name, 'rendered.html');
              if (fs.existsSync(f)) { htmlPath = f; break; }
            }
          }
        }

        if (!htmlPath) { res.writeHead(404); res.end('Page not captured'); return; }
        serveCapturePage(res, runOutputDir, path.relative(runOutputDir, htmlPath));
        return;
      }

      // ── 404 ──────────────────────────────────────────────────────────
      res.writeHead(404);
      res.end('Not found');

    } catch (e) {
      try { jsonResponse(res, 500, { error: e.message }); } catch { /* ignore */ }
    }
  });

  await new Promise(function(resolve, reject) {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  const origin = 'http://127.0.0.1:' + actualPort;

  function close() {
    return new Promise(function(resolve) {
      server.closeAllConnections();
      server.close(resolve);
    });
  }

  return { origin: origin, port: actualPort, close: close };
}

function tryReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
