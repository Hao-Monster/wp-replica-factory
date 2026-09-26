import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  buildCompositeKey,
  createSpikeQueueManager,
  runControlledSpikeCrawler
} from '../../tools/spike/crawlee-queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/spike-crawler');
const STORAGE_DIR = path.resolve(__dirname, '../../.replica/spike-queue-storage');

// Chromium blocked unsafe ports
const UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 556, 563, 587,
  601, 636, 993, 995, 2049, 3659, 4045, 6000, 6665, 6666, 6667, 6668, 6669, 6697
]);

function createTestServer() {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';

    const filePath = path.join(FIXTURES_DIR, reqPath);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    function tryListen() {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        if (UNSAFE_PORTS.has(port)) {
          server.close(() => tryListen());
        } else {
          resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
        }
      });
      server.once('error', reject);
    }
    tryListen();
  });
}

test('Crawlee RequestQueue: discovery, deduplication, state preservation and resumption', async (t) => {
  // Clean up any old storage
  if (fs.existsSync(STORAGE_DIR)) {
    fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  }

  const { server, baseUrl } = await createTestServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(STORAGE_DIR)) {
      fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
    }
  });

  await t.test('buildCompositeKey generates distinct keys for different states on same URL', () => {
    const keyDefault = buildCompositeKey({ url: `${baseUrl}/catalog.html`, stateId: 'default', viewport: '1440x1000' });
    const keyFilter = buildCompositeKey({ url: `${baseUrl}/catalog.html`, stateId: 'filter_opened', viewport: '1440x1000' });
    const keyFilterMobile = buildCompositeKey({ url: `${baseUrl}/catalog.html`, stateId: 'filter_opened', viewport: '390x844' });

    assert.notEqual(keyDefault, keyFilter, 'default and filter_opened must have different keys');
    assert.notEqual(keyFilter, keyFilterMobile, 'desktop and mobile must have different keys');
    assert.match(keyDefault, /#state=default@1440x1000$/);
  });

  let queueManager;
  let phase1Result;

  await t.test('Phase 1: Initial Crawl with Strict Budget triggers pause without false completion', async () => {
    queueManager = await createSpikeQueueManager({
      storageDir: STORAGE_DIR,
      queueName: 'poc-queue',
      purgeOnStart: true
    });

    // Seed entry requests for 2 viewports
    await queueManager.enqueue({ url: `${baseUrl}/`, stateId: 'default', viewport: '1440x1000' });
    await queueManager.enqueue({ url: `${baseUrl}/`, stateId: 'default', viewport: '390x844' });

    // Verify deduplication: adding identical request must return wasAlreadyPresent: true
    const dupRes = await queueManager.enqueue({ url: `${baseUrl}/`, stateId: 'default', viewport: '1440x1000' });
    assert.equal(dupRes.wasAlreadyPresent, true, 'Duplicate enqueue must be recognized by Crawlee');

    // Run crawler with tight budget (max 3 handled requests)
    phase1Result = await runControlledSpikeCrawler({
      queueManager,
      page,
      origin: baseUrl,
      maxHandledBudget: 3
    });

    assert.equal(phase1Result.status, 'BUDGET_PAUSED', 'Crawler must pause when budget is reached');
    assert.equal(phase1Result.handledThisRun, 3, 'Must handle exactly 3 requests in this run');
    assert.equal(phase1Result.finalStats.isFinished, false, 'Queue must NOT be finished');
    assert.ok(phase1Result.finalStats.pendingCount > 0, 'Pending requests must remain on disk in Crawlee storage');

    console.log('[Phase 1 Output]', JSON.stringify({
      status: phase1Result.status,
      handledCount: phase1Result.finalStats.handledCount,
      pendingCount: phase1Result.finalStats.pendingCount,
      isFinished: phase1Result.finalStats.isFinished,
      log: phase1Result.executionLog.map(l => ({ key: l.uniqueKey, state: l.stateId, viewport: l.viewport }))
    }, null, 2));
  });

  await t.test('Phase 2: Resumption from disk storage completes remaining requests and states', async () => {
    // Re-open existing queue from disk without purging
    const resumedQueueManager = await createSpikeQueueManager({
      storageDir: STORAGE_DIR,
      queueName: 'poc-queue',
      purgeOnStart: false
    });

    const resumedStats = await resumedQueueManager.getStats();
    assert.equal(resumedStats.handledCount, 3, 'Resumed queue must retain previously handled count');
    assert.ok(resumedStats.pendingCount > 0, 'Resumed queue must retain pending requests');

    // Run crawler with higher budget to complete all pending work
    const resumeResult = await runControlledSpikeCrawler({
      queueManager: resumedQueueManager,
      page,
      origin: baseUrl,
      maxHandledBudget: 20
    });

    console.log('[Phase 2 Debug]', JSON.stringify({
      status: resumeResult.status,
      handledThisRun: resumeResult.handledThisRun,
      finalStats: resumeResult.finalStats,
      log: resumeResult.executionLog.map(l => ({ key: l.uniqueKey, state: l.stateId, viewport: l.viewport }))
    }, null, 2));

    assert.equal(resumeResult.status, 'COMPLETED', 'Resumed crawl must complete naturally');
    assert.equal(resumeResult.finalStats.isFinished, true, 'Queue must report isFinished === true');
    assert.equal(resumeResult.finalStats.pendingCount, 0, 'No pending requests should remain');

    // Verify that across both phases all 3 pages were crawled
    const allHandled = [...phase1Result.executionLog, ...resumeResult.executionLog];
    const allUrls = allHandled.map((l) => l.url);
    assert.ok(allUrls.some((u) => u.endsWith('/')), 'Home page crawled');
    assert.ok(allUrls.some((u) => u.includes('catalog.html')), 'Catalog page crawled');
    assert.ok(allUrls.some((u) => u.includes('about.html')), 'About page crawled');

    // Verify that /catalog.html preserved multiple distinct states across execution
    const catalogStates = allHandled
      .filter((l) => l.url.includes('catalog.html'))
      .map((l) => l.stateId);

    assert.ok(catalogStates.includes('filter_opened'), 'filter_opened state was processed');
    assert.ok(catalogStates.includes('secondary_expanded'), 'secondary_expanded state was processed');

    console.log('[Phase 2 Output]', JSON.stringify({
      status: resumeResult.status,
      totalCount: resumeResult.finalStats.totalCount,
      handledCount: resumeResult.finalStats.handledCount,
      handledStates: [...new Set(resumeResult.executionLog.map((l) => l.stateId))],
      isFinished: resumeResult.finalStats.isFinished
    }, null, 2));
  });
});
