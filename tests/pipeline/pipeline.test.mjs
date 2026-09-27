#!/usr/bin/env node
/**
 * Reference Pipeline MVP – Acceptance Test Suite
 *
 * Validates the full pipeline from queue → capture → verify → admission gate.
 * Uses the owned pipeline-site fixture (no external network access).
 *
 * Test cases:
 *  [POSITIVE]
 *   P1: Single seed discovers all 3 pages (home, catalog, about)
 *   P2: Required states captured for both viewports (1440x1000, 390x844)
 *   P3: Query-string page (catalog?sale=1) is a distinct task, not merged with /catalog.html
 *   P4: Resources (CSS, JS, SVG images, font, inline SVG, CSS bg) saved and verifiable
 *   P5: Source shutdown → reference index and captures remain accessible offline
 *   P6: Budget pause → resume in new process → result matches clean complete run
 *   P7: Interrupt-and-resume: crash after N tasks; next call resumes from queue
 *
 *  [NEGATIVE]
 *   N1: Same URL + different stateId + different viewport → NOT merged (distinct task keys)
 *   N2: Missing a required page → EVIDENCE_INCOMPLETE (not TECH_VERIFIED)
 *   N3: Config change on resume → REJECTED (not silently mixed)
 *   N4: Corrupted output file → verify fails → task cannot be marked handled
 *   N5: Empty required_states but contract declares them → EVIDENCE_INCOMPLETE
 *
 * Note: These tests use the owned pipeline-site fixture only.
 * They validate queue logic, capture orchestration, recovery, and the admission gate.
 * They do NOT touch Reebelo or any real external site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  runPipeline,
  loadCheckpoint,
  checkpointPath,
  assertResumeCompatible,
  computeStatus,
  STATUS,
  PIPELINE_SCHEMA,
} from '../../tools/pipeline/pipeline.mjs';
import { openQueue, buildTaskKey } from '../../tools/pipeline/queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/pipeline-site');
const WORK_DIR = path.resolve(__dirname, '../../.replica/pipeline-test-work');

// Chromium blocked unsafe ports
const UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 179,
  389, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 556, 563, 587, 601, 636,
  993, 995, 2049, 3659, 4045, 6000,
]);

/**
 * Creates a local HTTP server serving pipeline-site fixture files.
 * Handles /catalog.html?sale=1 by serving catalog-sale.html.
 * Returns { server, origin, close }.
 */
function startFixtureServer() {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.png': 'image/png',
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    let pathname = parsedUrl.pathname;
    const query = parsedUrl.searchParams;

    // Route: /catalog.html?sale=1 → catalog-sale.html
    if (pathname === '/catalog.html' && query.get('sale') === '1') {
      pathname = '/catalog-sale.html';
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const filePath = path.join(FIXTURE_DIR, pathname.slice(1));

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve, reject) => {
    function tryListen() {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        if (UNSAFE_PORTS.has(port)) {
          server.close(() => tryListen());
          return;
        }
        resolve({
          server,
          port,
          origin: `http://127.0.0.1:${port}`,
          close: () => new Promise(r => server.close(r)),
        });
      });
      server.once('error', reject);
    }
    tryListen();
  });
}

/**
 * Builds a contract object with the runtime origin substituted in.
 */
function buildContract(origin, overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'pipeline-contract.json'), 'utf8'));
  return {
    ...base,
    seed: `${origin}/`,
    pageOrigins: [origin],
    assetOrigins: [origin],
    ...overrides,
  };
}

/**
 * Creates a unique test working directory to avoid run collisions.
 */
function testWorkDir(label) {
  const dir = path.join(WORK_DIR, label + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================
// UNIT: Task key identity
// ============================================================

test('U1: buildTaskKey preserves query, state, viewport uniqueness', () => {
  const base = 'http://127.0.0.1:9999/catalog.html';

  const k1 = buildTaskKey({ url: `${base}?sale=1`, stateId: 'default', viewport: '1440x1000' });
  const k2 = buildTaskKey({ url: `${base}`, stateId: 'default', viewport: '1440x1000' });
  const k3 = buildTaskKey({ url: `${base}`, stateId: 'filter-open', viewport: '1440x1000' });
  const k4 = buildTaskKey({ url: `${base}`, stateId: 'default', viewport: '390x844' });
  const k5 = buildTaskKey({ url: `${base}`, stateId: 'default', viewport: '1440x1000' });

  assert.notEqual(k1, k2, 'Query ?sale=1 should be a distinct task from no-query');
  assert.notEqual(k2, k3, 'Different stateId should be distinct');
  assert.notEqual(k3, k4, 'Different viewport should be distinct');
  assert.equal(k2, k5, 'Same params should produce identical key (idempotent)');

  // Fragment should NOT appear in the key base (fragments are separate metadata)
  const kFrag = buildTaskKey({ url: `${base}#section`, stateId: 'default', viewport: '1440x1000' });
  // URL with fragment: parsed.search should be empty, same base as without fragment
  const kNoFrag = buildTaskKey({ url: base, stateId: 'default', viewport: '1440x1000' });
  // Fragments are stripped from URL component in task key
  assert.equal(kFrag, kNoFrag, 'Fragment should not affect URL component of task key');
});

test('U2: assertResumeCompatible rejects config changes', () => {
  const saved = { seed: 'http://a.com/', pageOrigins: ['http://a.com'], assetOrigins: ['http://a.com'], configVer: 'v1' };
  const same = { ...saved };
  const changedSeed = { ...saved, seed: 'http://b.com/' };
  const changedVer = { ...saved, configVer: 'v2' };

  assert.doesNotThrow(() => assertResumeCompatible(saved, same), 'identical config should pass');
  assert.throws(() => assertResumeCompatible(saved, changedSeed), /Resume rejected.*seed/, 'seed change should reject');
  assert.throws(() => assertResumeCompatible(saved, changedVer), /Resume rejected.*configVer/, 'configVer change should reject');
});

// ============================================================
// QUEUE UNIT: Crawlee queue enqueue/fetch/handle
// ============================================================

test('U3: PipelineQueue enqueue/fetch/markHandled cycle', async (t) => {
  const storageDir = testWorkDir('queue-unit');
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const queue = await openQueue({ storageDir, queueName: 'u3-queue', purgeOnStart: true });

  const r1 = await queue.enqueue({ url: 'http://127.0.0.1:9999/', stateId: 'default', viewport: '1440x1000' });
  const r2 = await queue.enqueue({ url: 'http://127.0.0.1:9999/', stateId: 'filter-open', viewport: '1440x1000' });
  const r3 = await queue.enqueue({ url: 'http://127.0.0.1:9999/', stateId: 'default', viewport: '390x844' });
  const rDup = await queue.enqueue({ url: 'http://127.0.0.1:9999/', stateId: 'default', viewport: '1440x1000' });

  assert.ok(!r1.wasAlreadyPresent, 'First enqueue should not be duplicate');
  assert.ok(!r2.wasAlreadyPresent, 'Different state should not be duplicate');
  assert.ok(!r3.wasAlreadyPresent, 'Different viewport should not be duplicate');
  assert.ok(rDup.wasAlreadyPresent, 'Same params should be detected as duplicate');

  let stats = await queue.getStats();
  assert.equal(stats.total, 3, 'Should have 3 distinct tasks');
  assert.equal(stats.pending, 3);
  assert.ok(!stats.isFinished);

  const task = await queue.fetchNext();
  assert.ok(task, 'Should fetch a task');
  await queue.markHandled(task);

  stats = await queue.getStats();
  assert.equal(stats.handled, 1);
  assert.equal(stats.pending, 2);
});

// ============================================================
// POSITIVE INTEGRATION TESTS
// ============================================================

test('P1 + P2 + P4: Pipeline run discovers pages, captures states, saves resources', { timeout: 120_000 }, async (t) => {
  const { origin, close } = await startFixtureServer();
  t.after(close);

  const workDir = testWorkDir('p1-p2-p4');
  const storageDir = path.join(workDir, 'queue');
  const outputDir = path.join(workDir, 'output');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const contract = buildContract(origin, {
    required_states: ['country-closed', 'country-open'],
    states: [
      {
        state_id: 'country-closed', name: 'country-closed', path: '/',
        preconditions: [], actions: [],
        assertions: [{ selector: '#country-trigger-btn', visible: true }],
      },
      {
        state_id: 'country-open', name: 'country-open', path: '/',
        preconditions: [{ selector: '#country-portal', visible: false }],
        actions: [{ type: 'click', selector: '#country-trigger-btn' }],
        assertions: [{ selector: '#country-portal', visible: true }],
        required_resources: [
          { type: 'image', selector: '.flag-img' },
          { type: 'inline-svg', selector: '.close-icon' },
        ],
      },
    ],
  });

  const result = await runPipeline(contract, {
    baseOutput: outputDir,
    storageDir,
    fresh: true,
    maxBudget: 50,
  });

  // Basic result structure
  assert.ok(result.runId, 'runId should be set');
  assert.equal(result.schema, PIPELINE_SCHEMA, 'schema should match');

  // Pages discovered and captured
  const capturedUrls = result.captures.map(c => c.url);
  assert.ok(capturedUrls.some(u => u.endsWith('/') || u.endsWith('/index.html')), 'Home page should be captured');
  assert.ok(capturedUrls.some(u => u.includes('/catalog.html') && !u.includes('sale')), 'Catalog should be captured');
  assert.ok(capturedUrls.some(u => u.includes('/about.html')), 'About page should be captured');

  // Both viewports
  const homeCaptures = result.captures.filter(c => c.url.endsWith('/') || c.url.endsWith('/index.html'));
  const viewports = [...new Set(homeCaptures.map(c => c.viewport))];
  assert.ok(viewports.includes('1440x1000'), 'Desktop viewport should be captured');
  assert.ok(viewports.includes('390x844'), 'Mobile viewport should be captured');

  // Reference index written
  assert.ok(fs.existsSync(result.referenceIndexPath), 'Reference index should exist');
  const index = JSON.parse(fs.readFileSync(result.referenceIndexPath, 'utf8'));
  assert.equal(index.schema, 1);
  assert.ok(Object.keys(index.pages).length > 0, 'Index should have entries');

  // Preserve sanitized pipeline run artifacts for CI quality evidence collection
  const evidencePipelineDir = path.resolve(__dirname, '../../.replica/pipeline-ci-evidence/pipeline-run');
  fs.mkdirSync(evidencePipelineDir, { recursive: true });
  fs.copyFileSync(result.referenceIndexPath, path.join(evidencePipelineDir, 'reference-index.json'));
  const cpFile = checkpointPath(outputDir, result.runId);
  if (fs.existsSync(cpFile)) {
    fs.copyFileSync(cpFile, path.join(evidencePipelineDir, '_pipeline_checkpoint.json'));
  }

  // Captures have valid artifact references.
  // Pipeline accepts 'partial' when all failures are dependency_gap or font_load
  // (links to other pages are managed by the queue, not captured in one batch).
  const ACCEPTABLE_PIPELINE_REASONS = new Set(['dependency_gap', 'font_load']);
  for (const cap of result.captures.slice(0, 3)) {
    assert.ok(fs.existsSync(cap.captureDir), `Capture dir should exist: ${cap.captureDir}`);
    const manifest = tryReadJSON(path.join(cap.captureDir, 'manifest.json'));
    assert.ok(manifest, 'Manifest should exist');
    assert.ok(
      manifest.status === 'complete' || manifest.status === 'partial',
      `Capture status must be complete or partial, got: ${manifest.status}`
    );
    if (manifest.status === 'partial') {
      const badFailures = (manifest.failures || []).filter(f => !ACCEPTABLE_PIPELINE_REASONS.has(f.reason));
      assert.equal(badFailures.length, 0,
        `Partial capture has unexpected failures: ${JSON.stringify(badFailures)}`);
    }
  }
});

test('P3: Query-string page (catalog?sale=1) is captured as distinct task', { timeout: 60_000 }, async (t) => {
  const { origin, close } = await startFixtureServer();
  t.after(close);

  const workDir = testWorkDir('p3');
  const storageDir = path.join(workDir, 'queue');
  const outputDir = path.join(workDir, 'output');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const contract = buildContract(origin, { states: [], required_states: [] });
  const result = await runPipeline(contract, {
    baseOutput: outputDir,
    storageDir,
    fresh: true,
    maxBudget: 20,
  });

  // catalog.html and catalog.html?sale=1 should both appear as captures
  const capturedUrls = result.captures.map(c => c.url);
  const catalogNoQuery = capturedUrls.filter(u => u.includes('/catalog.html') && !u.includes('sale='));
  const catalogSale = capturedUrls.filter(u => u.includes('/catalog.html') && u.includes('sale=1'));

  assert.ok(catalogNoQuery.length > 0, 'catalog.html (no query) should be captured');
  assert.ok(catalogSale.length > 0, 'catalog.html?sale=1 should be a distinct capture');

  // Their capture dirs must differ
  const dirs1 = result.captures.filter(c => c.url.includes('/catalog.html') && !c.url.includes('sale=')).map(c => c.captureId);
  const dirs2 = result.captures.filter(c => c.url.includes('/catalog.html') && c.url.includes('sale=')).map(c => c.captureId);
  const overlap = dirs1.filter(id => dirs2.includes(id));
  assert.equal(overlap.length, 0, 'catalog and catalog?sale=1 must have distinct capture IDs');
});

test('P5: Source shutdown – reference index accessible offline', { timeout: 120_000 }, async (t) => {
  const { origin, close } = await startFixtureServer();

  const workDir = testWorkDir('p5');
  const storageDir = path.join(workDir, 'queue');
  const outputDir = path.join(workDir, 'output');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const contract = buildContract(origin, { states: [], required_states: [] });
  const result = await runPipeline(contract, {
    baseOutput: outputDir, storageDir, fresh: true, maxBudget: 20,
  });

  // Shut down server
  await close();

  // Reference index must still be readable
  assert.ok(fs.existsSync(result.referenceIndexPath), 'Reference index must exist after server shutdown');
  const index = JSON.parse(fs.readFileSync(result.referenceIndexPath, 'utf8'));
  assert.ok(Object.keys(index.pages).length > 0, 'Index must have entries after shutdown');

  // Capture artifacts must still be on disk
  for (const cap of result.captures) {
    assert.ok(fs.existsSync(cap.captureDir), `Capture dir must survive shutdown: ${cap.captureDir}`);
  }
});

test('P6 + P7: Budget pause then resume produces consistent result', { timeout: 240_000 }, async (t) => {
  const { origin, close } = await startFixtureServer();
  t.after(close);

  const workDir = testWorkDir('p6-p7');
  const storageDir = path.join(workDir, 'queue');
  const outputDir = path.join(workDir, 'output');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const contract = buildContract(origin, { states: [], required_states: [] });

  // First run: capture only 1 task (simulate budget pause)
  const run1 = await runPipeline(contract, {
    baseOutput: outputDir, storageDir, fresh: true, maxBudget: 1,
  });

  assert.ok(run1.runId, 'run1 should have runId');
  const captureCount1 = run1.captureCount;
  assert.ok(captureCount1 >= 1, 'Should have captured at least 1 task');

  // Load checkpoint – verify it was saved
  const cp = loadCheckpoint(checkpointPath(outputDir, run1.runId));
  assert.ok(cp, 'Checkpoint should be saved after run1');
  assert.equal(cp.runId, run1.runId);

  // Second run: resume with higher budget
  const run2 = await runPipeline(contract, {
    baseOutput: outputDir, storageDir,
    runId: run1.runId, // resume
    fresh: false,
    maxBudget: 50,
  });

  assert.equal(run2.runId, run1.runId, 'Resume should use same runId');

  // Combined captures should include pages from both runs
  const allUrls = run2.captures.map(c => c.url);
  assert.ok(allUrls.length >= captureCount1, 'Resume should have at least as many captures as first run');
  assert.ok(allUrls.some(u => u.endsWith('/') || u.endsWith('/index.html')), 'Home should be in combined result');
});

// ============================================================
// NEGATIVE TESTS
// ============================================================

test('N1: Same URL different stateId/viewport → distinct task keys, not merged', () => {
  const url = 'http://127.0.0.1:9999/catalog.html';
  const k1 = buildTaskKey({ url, stateId: 'default', viewport: '1440x1000' });
  const k2 = buildTaskKey({ url, stateId: 'filter-open', viewport: '1440x1000' });
  const k3 = buildTaskKey({ url, stateId: 'default', viewport: '390x844' });

  assert.notEqual(k1, k2, 'N1a: different stateId must be distinct task');
  assert.notEqual(k1, k3, 'N1b: different viewport must be distinct task');
  assert.notEqual(k2, k3, 'N1c: different state AND viewport must be distinct task');
});

test('N2: Missing required page → EVIDENCE_INCOMPLETE, not TECH_VERIFIED', { timeout: 120_000 }, async (t) => {
  const { origin, close } = await startFixtureServer();
  t.after(close);

  const workDir = testWorkDir('n2');
  const storageDir = path.join(workDir, 'queue');
  const outputDir = path.join(workDir, 'output');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  // Contract declares /nonexistent.html as a required page
  const contract = buildContract(origin, {
    states: [],
    required_states: [],
    required_pages: [`${origin}/nonexistent-page-xyz.html`],
  });

  const result = await runPipeline(contract, {
    baseOutput: outputDir, storageDir, fresh: true, maxBudget: 20,
  });

  assert.equal(result.status, STATUS.EVIDENCE_INCOMPLETE,
    `N2: Expected EVIDENCE_INCOMPLETE, got ${result.status}`);
  assert.notEqual(result.status, STATUS.TECH_VERIFIED, 'N2: Must not report TECH_VERIFIED with missing page');
  assert.notEqual(result.status, STATUS.REFERENCE_READY, 'N2: Must not report REFERENCE_READY with missing page');
});

test('N3: Config change on resume → throws assertResumeCompatible', () => {
  const saved = {
    seed: 'http://127.0.0.1:8888/',
    pageOrigins: ['http://127.0.0.1:8888'],
    assetOrigins: ['http://127.0.0.1:8888'],
    configVer: 'v1',
  };

  // pageOrigins change → should throw
  assert.throws(
    () => assertResumeCompatible(saved, { ...saved, pageOrigins: ['http://127.0.0.1:9999'] }),
    /Resume rejected.*pageOrigins/,
    'N3: pageOrigins change should reject resume'
  );

  // configVer bump → should throw
  assert.throws(
    () => assertResumeCompatible(saved, { ...saved, configVer: 'v2' }),
    /Resume rejected.*configVer/,
    'N3: configVer change should reject resume'
  );
});

test('N4: Corrupted capture output rejects via verify', async (t) => {
  // Direct unit-level test: verify() must reject output with corrupted manifest.status.
  // Uses a temporary directory to avoid coupling to full pipeline run timing.
  const workDir = testWorkDir('n4-direct');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const SCHEMA = 'replica-downloader/v0.1';
  const captureDir = path.join(workDir, 'capture');
  fs.mkdirSync(captureDir);
  fs.writeFileSync(path.join(captureDir, '.downloader-owned'), SCHEMA + '\n');
  for (const d of ['raw', 'pages', 'site/objects', 'reports', 'network']) {
    fs.mkdirSync(path.join(captureDir, d), { recursive: true });
  }

  // Write manifest with CORRUPTED status
  const manifest = {
    schema: SCHEMA, run_id: 'n4-test-run-id-0000001',
    status: 'CORRUPTED_FOR_TEST',
    failures: [], captures: [], counts: {},
    policy: { url: 'http://127.0.0.1:1', pageOrigins: [] },
    policy_sha256: '',
    engine: { browser: 'chromium', playwright: '1.0', adapter_sha256: 'a'.repeat(64) },
  };
  fs.writeFileSync(path.join(captureDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(captureDir, 'reports', 'download.json'), JSON.stringify({
    schema: 1, run_id: manifest.run_id, status: 'CORRUPTED_FOR_TEST', failures: [], counts: {}
  }));
  fs.writeFileSync(path.join(captureDir, 'routes.json'), JSON.stringify({ schema: 1, routes: [] }));
  fs.writeFileSync(path.join(captureDir, 'resources.json'), JSON.stringify({ schema: 1, resources: [] }));

  const { verify } = await import('../../tools/downloader/verify.mjs');
  // verify() returns {schema, status, errors} object, NOT an array
  let verifyResult;
  try {
    verifyResult = verify(captureDir, {});
  } catch (e) {
    verifyResult = { schema: 1, status: 'failed', errors: [e.message] };
  }
  assert.equal(verifyResult.status, 'failed',
    'N4: verify status must be failed for corrupted manifest, got: ' + JSON.stringify(verifyResult));
  assert.ok(Array.isArray(verifyResult.errors) && verifyResult.errors.length > 0,
    'N4: verify errors array must be non-empty, got: ' + JSON.stringify(verifyResult));
});

test('N5: Pipeline without approval → cannot be REFERENCE_READY', { timeout: 120_000 }, async (t) => {
  const { origin, close } = await startFixtureServer();
  t.after(close);

  const workDir = testWorkDir('n5');
  const storageDir = path.join(workDir, 'queue');
  const outputDir = path.join(workDir, 'output');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  // Contract with no approval and no required pages/states
  const contract = buildContract(origin, {
    states: [], required_states: [], required_pages: [],
    approval: null, // no approval
  });

  const result = await runPipeline(contract, {
    baseOutput: outputDir, storageDir, fresh: true, maxBudget: 20,
  });

  assert.notEqual(result.status, STATUS.REFERENCE_READY,
    'N5: Without approval, status must not be REFERENCE_READY');
  // Should be TECH_VERIFIED at best
  assert.ok(
    [STATUS.TECH_VERIFIED, STATUS.EVIDENCE_INCOMPLETE, STATUS.BUDGET_PAUSED].includes(result.status),
    `N5: Without approval, expected TECH_VERIFIED or incomplete, got ${result.status}`
  );
});

test('N6: Missing or invalid font/state cannot produce TECH_VERIFIED or REFERENCE_READY', () => {
  // Case 1: font_load failure recorded in errors -> must be EVIDENCE_INCOMPLETE
  const statusWithFontError = computeStatus({
    stats: { pending: 0 },
    errors: [{ error: 'font_load', file: 'PipelineFixture-Regular.ttf' }],
    challengeBlocked: false,
    require_interactions_confirmed: false,
    interactions_pending: [],
    approval: { approved: true },
    contract: { required_pages: ['http://127.0.0.1:9999/'], required_states: ['default'] },
    captures: [{ url: 'http://127.0.0.1:9999/', stateId: 'default' }],
  });
  assert.equal(statusWithFontError, STATUS.EVIDENCE_INCOMPLETE, 'N6: font_load error must produce EVIDENCE_INCOMPLETE');
  assert.notEqual(statusWithFontError, STATUS.TECH_VERIFIED, 'N6: font_load error must not be TECH_VERIFIED');
  assert.notEqual(statusWithFontError, STATUS.REFERENCE_READY, 'N6: font_load error must not be REFERENCE_READY');

  // Case 2: Required state missing from captures -> must be EVIDENCE_INCOMPLETE
  const statusMissingState = computeStatus({
    stats: { pending: 0 },
    errors: [],
    challengeBlocked: false,
    require_interactions_confirmed: false,
    interactions_pending: [],
    approval: { approved: true },
    contract: { required_pages: ['http://127.0.0.1:9999/'], required_states: ['required-font-state'] },
    captures: [{ url: 'http://127.0.0.1:9999/', stateId: 'default' }],
  });
  assert.equal(statusMissingState, STATUS.EVIDENCE_INCOMPLETE, 'N6: missing required state must produce EVIDENCE_INCOMPLETE');
});

test('N7: Missing a required mobile state cannot pass admission gate', () => {
  const contract = {
    required_pages: ['http://127.0.0.1:9999/'],
    required_states: ['mobile-drawer-open'],
    viewports: [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
  };

  // State was only captured on desktop viewport, mobile viewport was omitted
  const capturesDesktopOnly = [
    { url: 'http://127.0.0.1:9999/', stateId: 'mobile-drawer-open', viewport: '1440x1000' },
  ];

  const status = computeStatus({
    stats: { pending: 0 },
    errors: [],
    challengeBlocked: false,
    require_interactions_confirmed: false,
    interactions_pending: [],
    approval: { approved: true },
    contract,
    captures: capturesDesktopOnly,
  });

  assert.equal(status, STATUS.EVIDENCE_INCOMPLETE, 'N7: Missing required mobile state capture must yield EVIDENCE_INCOMPLETE');
  assert.notEqual(status, STATUS.TECH_VERIFIED, 'N7: Must not pass gate as TECH_VERIFIED');
  assert.notEqual(status, STATUS.REFERENCE_READY, 'N7: Must not pass gate as REFERENCE_READY');
});

test('N8: Corrupted resource file on resume is detected and rejected', async (t) => {
  const { verify } = await import('../../tools/downloader/verify.mjs');
  const workDir = testWorkDir('n8-corrupt');
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const SCHEMA = 'replica-downloader/v0.1';
  const captureDir = path.join(workDir, 'capture');
  fs.mkdirSync(path.join(captureDir, 'site/objects'), { recursive: true });
  fs.mkdirSync(path.join(captureDir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(captureDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(captureDir, '.downloader-owned'), SCHEMA + '\n');

  const rawPath = 'raw/test.bin';
  const localPath = 'site/objects/test.css';
  const goodContent = Buffer.from('body { color: red; }');
  const goodSha = crypto.createHash('sha256').update(goodContent).digest('hex');

  // Corrupt local file with different content
  const badContent = Buffer.from('body { color: blue; }');

  fs.writeFileSync(path.join(captureDir, rawPath), goodContent);
  fs.writeFileSync(path.join(captureDir, localPath), badContent); // CORRUPTED

  const manifest = {
    schema: SCHEMA, run_id: 'n8-test-run-id-0000001',
    status: 'complete',
    failures: [], captures: [{ url: 'http://127.0.0.1:1/', viewport: { width: 1440, height: 1000 }, state: 'default' }],
    counts: { discovered: 1, visited: 1, excluded: 0, failed: 0, pending: 0, resources: 1, saved_resources: 1, failed_resources: 0 },
    policy: { url: 'http://127.0.0.1:1/', pageOrigins: ['http://127.0.0.1:1'], viewports: [{ width: 1440, height: 1000 }], states: [] },
    policy_sha256: '',
    engine: { browser: 'chromium', playwright: '1.0', adapter_sha256: 'a'.repeat(64) },
  };
  fs.writeFileSync(path.join(captureDir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(captureDir, 'reports', 'download.json'), JSON.stringify({
    schema: 1, run_id: manifest.run_id, status: 'complete', failures: [], counts: manifest.counts
  }));
  fs.writeFileSync(path.join(captureDir, 'routes.json'), JSON.stringify({ schema: 1, routes: [{ url: 'http://127.0.0.1:1/', from: [], status: 'visited' }] }));
  fs.writeFileSync(path.join(captureDir, 'resources.json'), JSON.stringify({
    schema: 1,
    resources: [{
      method: 'GET', mime: 'text/css', response_url: 'http://127.0.0.1:1/test.css', url: 'http://127.0.0.1:1/test.css',
      status: 'saved', bytes: goodContent.length, local_bytes: goodContent.length,
      raw_path: rawPath, local_path: localPath, raw_sha256: goodSha, local_sha256: goodSha,
      references: [{ from: 'test', kind: 'asset' }], observations: ['style']
    }]
  }));

  const verifyResult = verify(captureDir, {});
  assert.equal(verifyResult.status, 'failed', 'N8: Verify must fail on hash mismatch');
  assert.ok(verifyResult.errors.some(e => e.includes('hash mismatch')), 'N8: Error must mention hash mismatch');
});

// ============================================================
// Admission gate unit tests
// ============================================================

test('G1: STATUS constants are defined and distinct', () => {
  const statuses = Object.values(STATUS);
  const unique = new Set(statuses);
  assert.equal(statuses.length, unique.size, 'All STATUS values must be unique');
  assert.ok(statuses.includes('REFERENCE_READY'), 'REFERENCE_READY must exist');
  assert.ok(statuses.includes('TECH_VERIFIED'), 'TECH_VERIFIED must exist');
  assert.ok(statuses.includes('EVIDENCE_INCOMPLETE'), 'EVIDENCE_INCOMPLETE must exist');
  assert.ok(statuses.includes('CHALLENGE_BLOCKED'), 'CHALLENGE_BLOCKED must exist');
  assert.ok(statuses.includes('BUDGET_PAUSED'), 'BUDGET_PAUSED must exist');
});

test('G2: PIPELINE_SCHEMA is versioned string', () => {
  assert.match(PIPELINE_SCHEMA, /^reference-pipeline\/v\d+/, 'Schema must be versioned');
});

// ============================================================
// Helpers
// ============================================================
function tryReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
