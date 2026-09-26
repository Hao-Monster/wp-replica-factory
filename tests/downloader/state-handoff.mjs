#!/usr/bin/env node
/**
 * Acceptance test suite for Explicit Interactive State Completeness
 * and Original Resource Handoff MVP.
 *
 * Verifies all 8 requirements in Section 7:
 * 1. Closed, open, secondary expand capture correct DOM and screenshot evidence.
 * 2. Closed action restores expected initial state.
 * 3. Ineffective click raises state_not_reached error.
 * 4. Missing required state fails completeness verification.
 * 5. Missing lazy resource or hash mismatch fails verification.
 * 6. Wrong route cannot pass as target state.
 * 7. Tampering report pass/status cannot mask missing files or states.
 * 8. Repeatable capture comparison across independent runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, safeFile, readJSON, put, json } from '../../tools/downloader/core.mjs';
import { download } from '../../tools/downloader/download.mjs';
import { verify, compareRuns } from '../../tools/downloader/verify.mjs';

const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/state-handoff');

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      let relPath = parsed.pathname;
      if (relPath === '/' || relPath === '/index.html') relPath = 'index.html';
      else if (relPath.startsWith('/')) relPath = relPath.slice(1);

      const filePath = path.join(FIXTURE_DIR, relPath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.json': 'application/json'
      };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

async function run() {
  console.log('Starting state-handoff acceptance test suite...');
  const { server, port, origin } = await startServer();
  const contractPath = path.join(FIXTURE_DIR, 'state-contract.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

  const basePolicy = {
    mode: 'owned-fixture',
    url: `${origin}/index.html`,
    pageOrigins: [origin],
    assetOrigins: [origin],
    viewports: contract.viewports,
    required_states: contract.required_states,
    states: contract.states,
    component: contract.component
  };

  const testRunsDir = path.join(ROOT, '.replica', 'state-handoff-test-' + Date.now());

  try {
    // -------------------------------------------------------------
    // Test 1: Full Capture with dual viewports & DOM/Screenshot evidence
    // -------------------------------------------------------------
    console.log('Test 1: Full Capture with dual viewports & DOM/Screenshot evidence');
    const run1Dir = path.join(testRunsDir, 'run-1');
    const { root: root1, manifest: m1 } = await download(basePolicy, run1Dir);

    assert.equal(m1.status, 'complete', `run-1 status should be complete, got: ${m1.status} (${JSON.stringify(m1.failures)})`);
    const v1 = verify(root1, { requireHandoff: true });
    assert.equal(v1.status, 'complete', `verify run-1 should be complete, got errors: ${JSON.stringify(v1.errors)}`);

    // Check dual viewport evidence for all states: 1 default + 4 contract states = 5 states x 2 viewports = 10 captures
    assert.equal(m1.captures.length, 10, `expected 10 captures (1 default + 4 contract states x 2 viewports), got: ${m1.captures.length}`);
    for (const stateId of contract.required_states) {
      for (const vp of contract.viewports) {
        const cap = m1.captures.find(c => c.state === stateId && c.viewport.width === vp.width && c.viewport.height === vp.height);
        assert.ok(cap, `missing capture for ${stateId} at ${vp.width}x${vp.height}`);

        // Verify screenshot file exists and is valid PNG
        const screenshotPath = safeFile(root1, cap.files['screenshot.png'].path);
        assert.ok(fs.existsSync(screenshotPath), `screenshot file missing: ${screenshotPath}`);
        const pngBuf = fs.readFileSync(screenshotPath);
        assert.ok(pngBuf.length > 0, 'screenshot file is empty');
        assert.equal(pngBuf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'invalid PNG magic header');

        // Verify rendered DOM
        const htmlPath = safeFile(root1, cap.files['rendered.html'].path);
        const html = fs.readFileSync(htmlPath, 'utf8');

        if (stateId === 'region-open' || stateId === 'language-expanded') {
          assert.ok(html.includes('id="region-portal"'), `expected #region-portal in ${stateId} DOM`);
          assert.ok(html.includes('assets/region-flag.svg'), `expected region flag in ${stateId} DOM`);
        } else {
          assert.ok(!html.includes('id="region-portal"'), `did not expect #region-portal in ${stateId} DOM`);
        }

        if (stateId === 'language-expanded') {
          assert.ok(html.includes('display: block'), 'expected lang-list to have display: block when expanded');
        }
      }
    }

    // Verify reports/component-handoff.json
    const handoff = readJSON(root1, 'reports/component-handoff.json');
    assert.equal(handoff.schema, 1, 'handoff schema must be 1');
    assert.equal(handoff.counts.missing_states, 0, 'missing states must be 0');
    assert.equal(handoff.counts.missing_files, 0, 'missing files must be 0');
    assert.ok(handoff.resource_catalog.length >= 3, 'catalog must record img, css-bg, and inline-svg');

    const flagRes = handoff.resource_catalog.find(r => r.source_url?.includes('region-flag.svg'));
    assert.ok(flagRes, 'region-flag.svg must be in catalog');
    assert.equal(flagRes.verified_on_disk, true, 'region-flag.svg must be verified on disk');

    const bgRes = handoff.resource_catalog.find(r => r.source_url?.includes('dialog-bg.svg'));
    assert.ok(bgRes, 'dialog-bg.svg must be in catalog');
    assert.equal(bgRes.verified_on_disk, true, 'dialog-bg.svg must be verified on disk');

    const svgRes = handoff.resource_catalog.find(r => r.kind === 'inline-svg');
    assert.ok(svgRes, 'inline close-icon SVG must be in catalog');
    assert.equal(svgRes.origin, 'inline', 'inline SVG must be marked origin inline');
    console.log('PASS Test 1: Full Capture with dual viewports & DOM/Screenshot evidence');

    // -------------------------------------------------------------
    // Test 2: State restoration verification
    // -------------------------------------------------------------
    console.log('Test 2: State restoration verification');
    for (const vp of contract.viewports) {
      const closedInitial = m1.captures.find(c => c.state === 'region-closed' && c.viewport.width === vp.width);
      const closedAgain = m1.captures.find(c => c.state === 'region-closed-again' && c.viewport.width === vp.width);
      const htmlInitial = fs.readFileSync(safeFile(root1, closedInitial.files['rendered.html'].path), 'utf8');
      const htmlAgain = fs.readFileSync(safeFile(root1, closedAgain.files['rendered.html'].path), 'utf8');
      assert.ok(!htmlInitial.includes('id="region-portal"'), 'initial state must have no portal');
      assert.ok(!htmlAgain.includes('id="region-portal"'), 'restored state must have no portal');
      assert.ok(htmlInitial.includes('id="region-trigger-btn"'), 'initial state must have trigger button');
      assert.ok(htmlAgain.includes('id="region-trigger-btn"'), 'restored state must have trigger button');
    }
    console.log('PASS Test 2: State restoration verification');

    // -------------------------------------------------------------
    // Test 3: Controllable negative - button clicked but state not reached
    // -------------------------------------------------------------
    console.log('Test 3: Controllable negative - button clicked but state not reached');
    const brokenPolicy = {
      ...basePolicy,
      required_states: ['broken-state'],
      states: [
        {
          state_id: 'broken-state',
          name: 'broken-state',
          path: '/index.html',
          actions: [{ type: 'click', selector: '#broken-region-btn' }],
          assertions: [{ selector: '#region-portal', visible: true }]
        }
      ]
    };
    const brokenDir = path.join(testRunsDir, 'run-broken');
    const { root: rootBroken, manifest: mBroken } = await download(brokenPolicy, brokenDir);
    assert.notEqual(mBroken.status, 'complete', 'broken button capture must not be complete');
    const hasStateNotReached = mBroken.failures.some(f => String(f.reason).includes('state_not_reached'));
    assert.ok(hasStateNotReached, `expected state_not_reached failure, got: ${JSON.stringify(mBroken.failures)}`);
    const vBroken = verify(rootBroken, { requireHandoff: true });
    assert.equal(vBroken.status, 'failed', 'verify must fail for broken state');
    console.log('PASS Test 3: Ineffective click raises state_not_reached error');

    // -------------------------------------------------------------
    // Test 4: Completeness negative - intentionally missing required state
    // -------------------------------------------------------------
    console.log('Test 4: Completeness negative - missing required state');
    const tamperedDir = path.join(testRunsDir, 'run-tampered-state');
    fs.cpSync(root1, tamperedDir, { recursive: true });
    const tamperedManifest = readJSON(tamperedDir, 'manifest.json');
    // Remove one required state from captures
    tamperedManifest.captures = tamperedManifest.captures.filter(c => c.state !== 'language-expanded');
    put(tamperedDir, 'manifest.json', json(tamperedManifest));
    const vTampered = verify(tamperedDir, { requireHandoff: true });
    assert.equal(vTampered.status, 'failed', 'verify must fail when required state is missing');
    assert.ok(vTampered.errors.some(e => e.includes('missing required state')), `expected missing required state error, got: ${JSON.stringify(vTampered.errors)}`);
    console.log('PASS Test 4: Missing required state fails completeness verification');

    // -------------------------------------------------------------
    // Test 5: Resource integrity negative - missing local file & hash mismatch
    // -------------------------------------------------------------
    console.log('Test 5: Resource integrity negative - missing local file & hash mismatch');
    const corruptDir = path.join(testRunsDir, 'run-corrupt-file');
    fs.cpSync(root1, corruptDir, { recursive: true });
    const handoffCorrupt = readJSON(corruptDir, 'reports/component-handoff.json');
    const targetRes = handoffCorrupt.resource_catalog.find(r => r.origin === 'network' && r.local_path);
    assert.ok(targetRes, 'target network resource must exist for corruption test');

    // Delete the file on disk
    const diskFile = safeFile(corruptDir, targetRes.local_path);
    fs.unlinkSync(diskFile);
    const vMissingFile = verify(corruptDir, { requireHandoff: true });
    assert.equal(vMissingFile.status, 'failed', 'verify must fail when resource file is missing');
    assert.ok(vMissingFile.errors.some(e => e.includes('missing resource file') || e.includes('resource failed') || e.includes('hash mismatch') || e.includes('ENOENT') || e.includes('no such file')), `expected file error, got: ${JSON.stringify(vMissingFile.errors)}`);

    // Write corrupted content (hash mismatch)
    fs.writeFileSync(diskFile, 'corrupted_content');
    const vHashMismatch = verify(corruptDir, { requireHandoff: true });
    assert.equal(vHashMismatch.status, 'failed', 'verify must fail when file content hash mismatches');
    console.log('PASS Test 5: Missing resource file or hash mismatch fails verification');

    // -------------------------------------------------------------
    // Test 6: Route error negative - wrong route cannot pass as target state
    // -------------------------------------------------------------
    console.log('Test 6: Route error negative - wrong route');
    const wrongRoutePolicy = {
      ...basePolicy,
      url: `${origin}/wrong-route-404.html`,
      required_states: ['region-closed'],
      states: [
        {
          state_id: 'region-closed',
          name: 'region-closed',
          path: '/wrong-route-404.html',
          expected_route: '/index.html',
          actions: [],
          assertions: [{ selector: '#region-trigger-btn', visible: true }]
        }
      ]
    };
    const wrongRouteDir = path.join(testRunsDir, 'run-wrong-route');
    const { root: rootWrong, manifest: mWrong } = await download(wrongRoutePolicy, wrongRouteDir);
    assert.notEqual(mWrong.status, 'complete', 'wrong route must not be complete');
    const vWrong = verify(rootWrong, { requireHandoff: true });
    assert.equal(vWrong.status, 'failed', 'verify must fail on wrong route');
    console.log('PASS Test 6: Wrong route cannot pass as target state');

    // -------------------------------------------------------------
    // Test 7: Anti-tamper negative - modifying pass/status cannot mask missing file
    // -------------------------------------------------------------
    console.log('Test 7: Anti-tamper negative - report pass cannot mask missing file');
    const tamperHandoffDir = path.join(testRunsDir, 'run-tamper-handoff');
    fs.cpSync(root1, tamperHandoffDir, { recursive: true });
    const handoffTampered = readJSON(tamperHandoffDir, 'reports/component-handoff.json');
    const targetFile = safeFile(tamperHandoffDir, handoffTampered.resource_catalog[0].local_path);
    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);

    // Fake status and counts
    handoffTampered.status = 'complete';
    handoffTampered.counts.missing_files = 0;
    put(tamperHandoffDir, 'reports/component-handoff.json', json(handoffTampered));

    const vTamperedHandoff = verify(tamperHandoffDir, { requireHandoff: true });
    assert.equal(vTamperedHandoff.status, 'failed', 'anti-tamper verification must catch missing file despite status=complete');
    console.log('PASS Test 7: Tampering report pass cannot mask missing file');

    // -------------------------------------------------------------
    // Test 8: Reproducibility - 2nd independent capture matches run 1
    // -------------------------------------------------------------
    console.log('Test 8: Reproducibility - 2nd independent capture matches run 1');
    const run2Dir = path.join(testRunsDir, 'run-2');
    const { root: root2, manifest: m2 } = await download(basePolicy, run2Dir);
    assert.equal(m2.status, 'complete', 'run-2 must be complete');
    const v2 = verify(root2, { requireHandoff: true });
    assert.equal(v2.status, 'complete', 'verify run-2 must be complete');

    const comp = compareRuns(root1, root2);
    assert.equal(comp.status, 'complete', 'compareRuns between run-1 and run-2 must be complete');
    assert.equal(comp.equal, true, 'compareRuns must report runs are equal');
    console.log('PASS Test 8: Independent repeat run is deterministic and equal');

    console.log('\nAll 8 state-handoff acceptance tests passed successfully!');
    return 0;
  } finally {
    server.close();
    try {
      fs.rmSync(testRunsDir, { recursive: true, force: true });
    } catch {}
  }
}

run()
  .then(code => process.exit(code || 0))
  .catch(err => {
    console.error('State handoff test failed:', err);
    process.exit(1);
  });
