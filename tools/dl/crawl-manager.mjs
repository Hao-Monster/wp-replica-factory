/**
 * WP Replica Factory – Domain Crawl Manager
 *
 * 整站爬取管理器：
 * - 从单个域名自动生成运行配置（无需预先写contract.json）
 * - 自动发现 sitemap.xml / sitemap_index.xml / robots.txt
 * - 逐页调用现有 downloader（download.mjs），保存完整渲染后HTML
 * - 使用现有 Crawlee 持久队列（queue.mjs）实现暂停/恢复
 * - 保存一页后立即更新索引，让UI实时展示已完成页面
 *
 * 复用上游（不重写）：
 *   tools/downloader/download.mjs   – Playwright采集
 *   tools/pipeline/queue.mjs        – Crawlee持久队列
 *   tools/downloader/core.mjs       – sha/json/put/safeFile
 *
 * 模式：authorized-public（HTTPS，单一pageOrigin，assetOrigins自动从首页响应收集）
 *
 * @module crawl-manager
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { sha, json } from '../downloader/core.mjs';
import { openQueue } from '../pipeline/queue.mjs';

export const CRAWL_SCHEMA = 'dl-crawl-manager/v0.1';

export const RUN_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
  EXHAUSTED: 'exhausted',
};

// ─── Default config ────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  maxPages: 0,            // 0 = unlimited (整站模式)
  maxDepth: 8,
  concurrency: 1,         // sequential per Playwright process model
  pageTimeoutMs: 45000,
  budgetMs: 0,            // 0 = no time limit
  maxResources: 3000,
  maxBytes: 30 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  viewports: [{ width: 1440, height: 900 }],
  sensitiveQueryKeys: [
    'token', 'access_token', 'api_key', 'password', 'secret',
    'authorization', 'session', 'cookie',
  ],
  trackingParams: [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'mc_eid', 'ref', '_ga',
  ],
};

// ─── Run State ────────────────────────────────────────────────────────────

export class CrawlRun {
  constructor({ runId, domain, outputDir, storageDir, config }) {
    this.runId = runId || crypto.randomUUID();
    this.domain = domain;
    this.outputDir = path.resolve(outputDir);
    this.storageDir = path.resolve(storageDir);
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.status = RUN_STATUS.IDLE;
    this.startedAt = null;
    this.pausedAt = null;
    this.stats = {
      discovered: 0,
      queued: 0,
      saved: 0,
      failed: 0,
      skipped: 0,
      resources: 0,
      running: 0,
    };
    this._queue = null;
    this._running = false;
    this._pausing = false;
    this.assetOrigins = [];
    this._pageIndex = { pages: {} };
  }

  get cpPath() {
    return path.join(this.outputDir, '.crawl-checkpoint.json');
  }

  get indexPath() {
    return path.join(this.outputDir, 'crawl-index.json');
  }

  get origin() {
    try { return new URL('https://' + this.domain).origin; } catch { return null; }
  }

  saveCheckpoint() {
    const state = {
      schema: CRAWL_SCHEMA,
      runId: this.runId,
      domain: this.domain,
      config: this.config,
      status: this.status,
      startedAt: this.startedAt,
      stats: this.stats,
      assetOrigins: this.assetOrigins,
    };
    const tmp = this.cpPath + '.tmp';
    fs.mkdirSync(path.dirname(this.cpPath), { recursive: true });
    fs.writeFileSync(tmp, json(state));
    fs.renameSync(tmp, this.cpPath);
  }

  recordPage(url, entry) {
    this._pageIndex.pages[url] = {
      ...this._pageIndex.pages[url],
      ...entry,
      updatedAt: new Date().toISOString(),
    };
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, json({
      schema: CRAWL_SCHEMA,
      runId: this.runId,
      domain: this.domain,
      generatedAt: new Date().toISOString(),
      stats: this.stats,
      status: this.status,
      pages: this._pageIndex.pages,
    }));
    fs.renameSync(tmp, this.indexPath);
  }
}

// ─── Checkpoint I/O ──────────────────────────────────────────────────────

export function loadRunState(outputDir) {
  const cpPath = path.join(path.resolve(outputDir), '.crawl-checkpoint.json');
  try { return JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { return null; }
}

export function loadPageIndex(outputDir) {
  const indexPath = path.join(path.resolve(outputDir), 'crawl-index.json');
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return null; }
}

// ─── URL utilities ────────────────────────────────────────────────────────

export function dedupeKey(url, trackingParams) {
  const tp = trackingParams || DEFAULT_CONFIG.trackingParams;
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of tp) u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}

export function shouldCrawl(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return false;
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const ext = u.pathname.split('.').pop().toLowerCase();
    const mediaExts = [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'css', 'js',
      'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mp3', 'pdf', 'zip', 'gz',
      'tar', 'xml', 'json', 'txt', 'csv', 'rss', 'atom',
    ];
    if (mediaExts.includes(ext)) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Sitemap discovery ───────────────────────────────────────────────────

export async function discoverSitemapUrls(origin) {
  const candidates = [];
  try {
    const txt = await fetchText(origin + '/robots.txt');
    for (const line of txt.split('\n')) {
      const m = line.match(/^Sitemap:\s*(.+)/i);
      if (m) candidates.push(m[1].trim());
    }
  } catch { /* ignore */ }
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/sitemap.xml']) {
    const u = origin + p;
    if (!candidates.includes(u)) candidates.push(u);
  }
  return candidates;
}

async function parseSitemap(url, visited) {
  if (!visited) visited = new Set();
  if (visited.has(url) || visited.size > 50) return [];
  visited.add(url);
  let text;
  try { text = await fetchText(url, 15000); } catch { return []; }
  const locs = [];
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = locRe.exec(text)) !== null) locs.push(m[1]);
  const isSitemapIndex = /<sitemap>/i.test(text);
  if (isSitemapIndex) {
    const results = [];
    for (const loc of locs) {
      const sub = await parseSitemap(loc, visited);
      results.push(...sub);
    }
    return results;
  }
  return locs;
}

// ─── HTTP fetch ──────────────────────────────────────────────────────────

function fetchText(url, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  return new Promise(function(resolve, reject) {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, function(res) {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── HTML utilities ───────────────────────────────────────────────────────

export function extractLinks(html, baseUrl, origin) {
  const links = new Set();
  const hrefRe = /href\s*=\s*["']([^"'#][^"']*?)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const resolved = new URL(href, baseUrl);
      resolved.hash = '';
      if (resolved.origin === origin) links.add(resolved.toString());
    } catch { /* ignore */ }
  }
  return [...links];
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

// ─── Per-page download ────────────────────────────────────────────────────

async function downloadPage(url, run, captureDir) {
  const { download } = await import('../downloader/download.mjs');
  const origin = run.origin;
  const assetOrigins = run.assetOrigins.length > 0
    ? [...new Set([origin].concat(run.assetOrigins))]
    : [origin];

  const policy = {
    mode: 'authorized-public',
    url: url,
    pageOrigins: [origin],
    assetOrigins: assetOrigins,
    viewports: run.config.viewports,
    maxPages: 1,
    maxDepth: 0,
    timeoutMs: run.config.pageTimeoutMs,
    budgetMs: run.config.pageTimeoutMs * 2,
    maxResources: run.config.maxResources,
    maxBytes: run.config.maxBytes,
    maxTotalBytes: run.config.maxTotalBytes,
    sensitiveQueryKeys: run.config.sensitiveQueryKeys,
    publicGetFixtures: [],
    states: [],
    required_states: [],
    har: false,
  };

  let result;
  try {
    result = await download(policy, captureDir);
  } catch (e) {
    return { status: 'failed', error: e.message, links: [], title: '', counts: {} };
  }

  const manifest = result.manifest;
  const htmlPath = findRenderedHtml(captureDir);
  const html = htmlPath ? fs.readFileSync(htmlPath, 'utf8') : '';
  const links = html ? extractLinks(html, url, origin) : [];
  const title = html ? extractTitle(html) : '';

  // Collect asset origins from saved resources
  try {
    const resources = JSON.parse(fs.readFileSync(path.join(captureDir, 'resources.json'), 'utf8'));
    for (const r of (resources.resources || [])) {
      if (r.url && r.status === 'saved') {
        try {
          const ro = new URL(r.url).origin;
          if (ro !== origin && !run.assetOrigins.includes(ro) && ro.startsWith('https://')) {
            run.assetOrigins.push(ro);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  const blocked = manifest && manifest.status === 'blocked';
  const ok = !!htmlPath && !blocked;

  return {
    status: blocked ? 'blocked' : (ok ? 'saved' : 'partial'),
    htmlPath: ok ? path.relative(run.outputDir, htmlPath) : null,
    captureDir: path.relative(run.outputDir, captureDir),
    links: links,
    title: title,
    error: manifest && manifest.challenge && manifest.challenge.detected
      ? 'challenge: ' + manifest.challenge.kind
      : (manifest && manifest.status === 'failed' ? 'download failed' : null),
    counts: (manifest && manifest.counts) || {},
  };
}

function findRenderedHtml(captureDir) {
  const pagesDir = path.join(captureDir, 'pages');
  if (!fs.existsSync(pagesDir)) return null;
  for (const entry of fs.readdirSync(pagesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const f = path.join(pagesDir, entry.name, 'rendered.html');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

function captureIdForUrl(url) {
  return sha(url).slice(0, 32);
}

function captureDirFor(run, url) {
  return path.join(run.outputDir, 'captures', captureIdForUrl(url));
}

function tryReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ─── Main orchestrator ────────────────────────────────────────────────────

export async function runCrawl(run, opts) {
  if (!opts) opts = {};
  const onProgress = opts.onProgress || null;

  if (run._running) throw new Error('already running');
  run._running = true;
  run._pausing = false;
  run.status = RUN_STATUS.RUNNING;
  if (!run.startedAt) run.startedAt = new Date().toISOString();

  fs.mkdirSync(run.outputDir, { recursive: true });
  fs.mkdirSync(run.storageDir, { recursive: true });
  run.saveCheckpoint();

  const isFresh = !run._queue &&
    !fs.existsSync(path.join(run.storageDir, 'request_queues'));

  run._queue = await openQueue({
    storageDir: run.storageDir,
    queueName: 'dl-' + run.runId,
    purgeOnStart: isFresh,
  });

  const origin = run.origin;

  // Seed: sitemap + homepage
  const seedUrls = new Set();
  seedUrls.add(origin + '/');

  try {
    const sitemapCandidates = await discoverSitemapUrls(origin);
    for (const sUrl of sitemapCandidates) {
      const pages = await parseSitemap(sUrl);
      for (const p of pages) {
        const key = dedupeKey(p, run.config.trackingParams);
        if (shouldCrawl(key, origin)) seedUrls.add(key);
      }
    }
    console.log('[dl] Sitemap discovery: ' + seedUrls.size + ' seed URLs');
  } catch (e) {
    console.warn('[dl] Sitemap discovery: ' + e.message);
  }

  // Enqueue seeds not yet seen
  for (const u of seedUrls) {
    if (!run._pageIndex.pages[u]) {
      await run._queue.enqueue({ url: u, stateId: 'default', viewport: '1440x900' });
      run.stats.queued++;
    }
  }

  // Process loop
  const maxPages = run.config.maxPages;
  let blocked = false;

  while (!run._pausing && !blocked) {
    const qStats = await run._queue.getStats();
    if (qStats.pending === 0) break;
    if (maxPages > 0 && run.stats.saved >= maxPages) {
      run.status = RUN_STATUS.EXHAUSTED;
      break;
    }

    const task = await run._queue.fetchNext();
    if (!task) break;

    const url = task.url;
    const deduped = dedupeKey(url, run.config.trackingParams);

    // Skip already-saved pages
    if (run._pageIndex.pages[deduped] && run._pageIndex.pages[deduped].status === 'saved') {
      await run._queue.markHandled(task);
      run.stats.skipped++;
      continue;
    }

    run.stats.running++;
    run.recordPage(deduped, { status: 'running', url: deduped });

    const captureDir = captureDirFor(run, deduped);
    let pageResult = null;

    try {
      // Resume: reuse existing complete capture
      if (fs.existsSync(captureDir)) {
        const existingManifest = tryReadJSON(path.join(captureDir, 'manifest.json'));
        if (existingManifest && (existingManifest.status === 'complete' || existingManifest.status === 'partial')) {
          const htmlPath = findRenderedHtml(captureDir);
          if (htmlPath) {
            const html = fs.readFileSync(htmlPath, 'utf8');
            pageResult = {
              status: 'saved',
              htmlPath: path.relative(run.outputDir, htmlPath),
              captureDir: path.relative(run.outputDir, captureDir),
              links: extractLinks(html, url, origin),
              title: extractTitle(html),
              counts: existingManifest.counts || {},
              reused: true,
            };
          }
        }
      }

      if (!pageResult) {
        pageResult = await downloadPage(url, run, captureDir);
      }

      if (pageResult.status === 'blocked') {
        blocked = true;
        run.status = RUN_STATUS.BLOCKED;
        run.stats.running--;
        run.stats.failed++;
        run.recordPage(deduped, { status: 'blocked', error: pageResult.error });
        await run._queue.markHandled(task);
        break;
      }

      if (pageResult.status === 'saved' || pageResult.status === 'partial') {
        run.stats.saved++;
        run.stats.resources += (pageResult.counts && pageResult.counts.resources) || 0;
        run.recordPage(deduped, {
          status: 'saved',
          htmlPath: pageResult.htmlPath,
          captureDir: pageResult.captureDir,
          title: pageResult.title,
          savedAt: new Date().toISOString(),
          counts: pageResult.counts,
        });
        await run._queue.markHandled(task);

        // Discover and enqueue new links
        for (const link of pageResult.links) {
          const linkKey = dedupeKey(link, run.config.trackingParams);
          if (shouldCrawl(linkKey, origin) && !run._pageIndex.pages[linkKey]) {
            const enq = await run._queue.enqueue({
              url: linkKey,
              stateId: 'default',
              viewport: '1440x900',
            });
            if (!enq.wasAlreadyPresent) {
              run.stats.discovered++;
              run.stats.queued++;
              run.recordPage(linkKey, { status: 'queued', url: linkKey });
            }
          }
        }
      } else {
        run.stats.failed++;
        run.recordPage(deduped, { status: 'failed', error: pageResult.error });
        await run._queue.markHandled(task);
      }
    } catch (e) {
      run.stats.failed++;
      run.recordPage(deduped, { status: 'failed', error: e.message });
      try { await run._queue.markHandled(task); } catch { /* ignore */ }
    } finally {
      run.stats.running = Math.max(0, run.stats.running - 1);
    }

    run.saveCheckpoint();

    if (onProgress) {
      try { await onProgress(run, deduped, pageResult); } catch { /* ignore */ }
    }
  }

  if (!blocked) {
    const qStats = await run._queue.getStats();
    if (run._pausing) {
      run.status = RUN_STATUS.PAUSED;
      run.pausedAt = new Date().toISOString();
    } else if (qStats.pending === 0) {
      run.status = RUN_STATUS.COMPLETE;
    }
  }

  run._running = false;
  run.saveCheckpoint();
  return run;
}

export async function resumeCrawl(outputDir, storageDir, opts) {
  if (!opts) opts = {};
  const state = loadRunState(outputDir);
  if (!state) throw new Error('No checkpoint found in ' + outputDir);

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

  return runCrawl(run, opts);
}
