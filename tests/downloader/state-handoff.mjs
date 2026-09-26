#!/usr/bin/env node
/**
 * Acceptance test suite for Explicit Interactive State Completeness
 * and Original Resource Handoff MVP.
 *
 * Verifies all requirements:
 * 1. Dual viewports & DOM/Screenshot evidence with capture identity association.
 * 2. State restoration verification (restores_state).
 * 3. Ineffective click raises state_not_reached error.
 * 4. Completeness negative: missing required state or single mobile case fails verify.
 * 5. Resource integrity negative: missing local file, corrupted hash, or missing SVG fails verify.
 * 6. Route mismatch negative: HTTP 200 readable page but wrong route fails state check.
 * 7. Anti-tamper negative: modifying pass/status or faking counts cannot bypass verify.
 * 8. Repeatable capture comparison across independent runs (compareRuns).
 * 9. Cross-page and multi-viewport identity isolation (same state name on two pages).
 * 10. Delay handling: delayed element succeeds within budget; non-existent element fails.
 * 11. Partial visibility: min_count fails when only first element is visible.
 * 12. Broken restoration: action failing to restore invariant triggers state_restoration_failed.
 * 13. Required resource missing: missing selector triggers required_resource_missing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, safeFile, readJSON, put, json, sha } from '../../tools/downloader/core.mjs';
import { download } from '../../tools/downloader/download.mjs';
import { verify, compareRuns } from '../../tools/downloader/verify.mjs';

const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/state-handoff');

const UNSAFE_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 179, 389, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 556, 563, 587, 601, 636, 993, 995, 2049, 3659, 4045, 6000]);

function startServer() {
  return new Promise((resolve, reject) => {
    function tryListen() {
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
        if (UNSAFE_PORTS.has(port)) {
          server.close(() => tryListen());
          return;
        }
        resolve({ server, port, origin: `http://127.0.0.1:${port}` });
      });
      server.on('error', reject);
    }
    tryListen();
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
    assert.equal(handoff.counts.required_state_definitions, 4, 'required state definitions must be 4');
    assert.equal(handoff.counts.required_cases, 8, 'required cases must be 8 (4 states x 2 viewports)');
    assert.equal(handoff.counts.actual_valid_cases, 8, 'actual valid cases must be 8');
    assert.equal(handoff.counts.missing_cases, 0, 'missing cases must be 0');
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
    assert.ok(svgRes.local_path, 'inline SVG must have local_path');
    assert.equal(svgRes.verified_on_disk, true, 'inline SVG must be verified on disk');
    assert.ok(fs.existsSync(safeFile(root1, svgRes.local_path)), 'inline SVG file must exist on disk');
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
    // Test 4A: Completeness negative - intentionally deleting 1 mobile case
    // -------------------------------------------------------------
    console.log('Test 4A: Completeness negative - missing mobile required case');
    const tamperedDirA = path.join(testRunsDir, 'run-tampered-mobile-case');
    fs.cpSync(root1, tamperedDirA, { recursive: true });
    const tamperedManifestA = readJSON(tamperedDirA, 'manifest.json');
    // Remove only the mobile capture for language-expanded
    tamperedManifestA.captures = tamperedManifestA.captures.filter(c => !(c.state === 'language-expanded' && c.viewport.width === 390));
    put(tamperedDirA, 'manifest.json', json(tamperedManifestA));
    const vTamperedA = verify(tamperedDirA, { requireHandoff: true });
    assert.equal(vTamperedA.status, 'failed', 'verify must fail when mobile required case is deleted');
    assert.ok(vTamperedA.errors.some(e => e.includes('language-expanded') && e.includes('390')), `expected missing mobile case error, got: ${JSON.stringify(vTamperedA.errors)}`);
    console.log('PASS Test 4A: Missing mobile required case fails verify');

    // -------------------------------------------------------------
    // Test 4B: Completeness negative - blanking handoff contract & states
    // -------------------------------------------------------------
    console.log('Test 4B: Completeness negative - blanking handoff report states while manifest intact');
    const tamperedDirB = path.join(testRunsDir, 'run-tampered-blank-handoff');
    fs.cpSync(root1, tamperedDirB, { recursive: true });
    const handoffTamperedB = readJSON(tamperedDirB, 'reports/component-handoff.json');
    handoffTamperedB.contract = { required_states: [], required_cases: 0, viewports: [] };
    handoffTamperedB.states = [];
    handoffTamperedB.resource_catalog = [];
    put(tamperedDirB, 'reports/component-handoff.json', json(handoffTamperedB));
    const vTamperedB = verify(tamperedDirB, { requireHandoff: true });
    assert.equal(vTamperedB.status, 'failed', 'verify must fail when handoff contract is blanked');
    assert.ok(vTamperedB.errors.some(e => e.includes('empty or tampered') || e.includes('missing or invalid handoff state')), `expected empty contract error, got: ${JSON.stringify(vTamperedB.errors)}`);
    console.log('PASS Test 4B: Blanking handoff report states fails verify');

    // -------------------------------------------------------------
    // Test 5A: Resource integrity negative - missing network file & hash mismatch
    // -------------------------------------------------------------
    console.log('Test 5A: Resource integrity negative - missing local file & hash mismatch');
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
    assert.ok(vMissingFile.errors.some(e => e.includes('missing resource file') || e.includes('resource failed') || e.includes('ENOENT')), `expected file error, got: ${JSON.stringify(vMissingFile.errors)}`);

    // Write corrupted content (hash mismatch)
    fs.writeFileSync(diskFile, 'corrupted_content');
    const vHashMismatch = verify(corruptDir, { requireHandoff: true });
    assert.equal(vHashMismatch.status, 'failed', 'verify must fail when file content hash mismatches');
    console.log('PASS Test 5A: Missing resource file or hash mismatch fails verification');

    // -------------------------------------------------------------
    // Test 5B: Resource integrity negative - missing or replaced inline SVG file
    // -------------------------------------------------------------
    console.log('Test 5B: Resource integrity negative - missing or replaced inline SVG');
    const svgCorruptDir = path.join(testRunsDir, 'run-corrupt-svg');
    fs.cpSync(root1, svgCorruptDir, { recursive: true });
    const handoffSvg = readJSON(svgCorruptDir, 'reports/component-handoff.json');
    const targetSvg = handoffSvg.resource_catalog.find(r => r.kind === 'inline-svg' && r.local_path);
    assert.ok(targetSvg, 'target inline-svg must exist for corruption test');

    const svgFile = safeFile(svgCorruptDir, targetSvg.local_path);
    fs.unlinkSync(svgFile);
    const vMissingSvg = verify(svgCorruptDir, { requireHandoff: true });
    assert.equal(vMissingSvg.status, 'failed', 'verify must fail when inline svg file is missing');
    assert.ok(vMissingSvg.errors.some(e => e.includes('missing resource file')), `expected missing svg error, got: ${JSON.stringify(vMissingSvg.errors)}`);

    // Corrupt SVG content
    fs.writeFileSync(svgFile, '<svg><path d="tampered"/></svg>');
    const vCorruptSvg = verify(svgCorruptDir, { requireHandoff: true });
    assert.equal(vCorruptSvg.status, 'failed', 'verify must fail when inline svg content is tampered');
    console.log('PASS Test 5B: Missing or replaced inline SVG fails verification');

    // -------------------------------------------------------------
    // Test 6: Route error negative - HTTP 200 readable page but route mismatch
    // -------------------------------------------------------------
    console.log('Test 6: Route error negative - HTTP 200 readable page but wrong route');
    const wrongRoutePolicy = {
      ...basePolicy,
      url: `${origin}/page2.html`,
      required_states: ['region-closed'],
      states: [
        {
          state_id: 'region-closed',
          name: 'region-closed',
          path: '/page2.html',
          expected_route: '/index.html', // Contradiction: visited page is /page2.html (HTTP 200), but contract expects /index.html
          actions: [],
          assertions: [{ selector: '#region-trigger-btn', visible: true }]
        }
      ]
    };
    const wrongRouteDir = path.join(testRunsDir, 'run-wrong-route');
    const { root: rootWrong, manifest: mWrong } = await download(wrongRoutePolicy, wrongRouteDir);
    assert.notEqual(mWrong.status, 'complete', 'wrong route must not be complete');
    const hasRouteError = mWrong.failures.some(f => String(f.reason).includes('route mismatch'));
    assert.ok(hasRouteError, `expected route mismatch failure, got: ${JSON.stringify(mWrong.failures)}`);
    const vWrong = verify(rootWrong, { requireHandoff: true });
    assert.equal(vWrong.status, 'failed', 'verify must fail on wrong route');
    console.log('PASS Test 6: HTTP 200 readable page but wrong route fails state check');

    // -------------------------------------------------------------
    // Test 7: Anti-tamper negative - modifying pass/status or faking counts
    // -------------------------------------------------------------
    console.log('Test 7: Anti-tamper negative - report pass cannot mask missing file or counts');
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
    assert.equal(comp.state_differences?.length || 0, 0, 'state differences must be empty');
    console.log('PASS Test 8: Independent repeat run is deterministic and equal');

    // -------------------------------------------------------------
    // Test 9: Cross-page and multi-viewport identity isolation
    // -------------------------------------------------------------
    console.log('Test 9: Cross-page and multi-viewport identity isolation');
    const multiPagePolicy = {
      ...basePolicy,
      url: `${origin}/index.html`,
      maxPages: 2,
      required_states: ['region-closed'],
      states: [
        {
          state_id: 'region-closed',
          name: 'region-closed',
          actions: [],
          assertions: [{ selector: '#region-trigger-btn', visible: true }]
        }
      ]
    };
    const multiPageDir = path.join(testRunsDir, 'run-multipage');
    const { root: rootMulti, manifest: mMulti } = await download(multiPagePolicy, multiPageDir);
    const handoffMulti = readJSON(rootMulti, 'reports/component-handoff.json');
    // Ensure case_keys accurately encode route and viewport
    const caseKeys = handoffMulti.states.map(s => s.case_key);
    assert.ok(caseKeys.some(k => k.includes('/index.html') && k.includes('1440x1000')), 'must have index 1440 case');
    assert.ok(caseKeys.some(k => k.includes('/index.html') && k.includes('390x844')), 'must have index 390 case');
    const uniqueKeys = new Set(caseKeys);
    assert.equal(uniqueKeys.size, caseKeys.length, 'all case keys must be unique without cross-contamination');
    console.log('PASS Test 9: Cross-page and multi-viewport identity isolation');

    // -------------------------------------------------------------
    // Test 10: Delay handling (positive & negative)
    // -------------------------------------------------------------
    console.log('Test 10: Delay handling - delayed element succeeds, non-existent times out');
    const delayedPolicy = {
      ...basePolicy,
      required_states: ['delayed-state'],
      states: [
        contract.states[1], // region-open ensures CSS background dialog-bg.svg is fetched
        {
          state_id: 'delayed-state',
          name: 'delayed-state',
          path: '/index.html',
          actions: [{ type: 'click', selector: '#delay-trigger-btn' }],
          assertions: [{ selector: '#delay-target', visible: true, text: 'Delayed Panel Appeared' }]
        }
      ]
    };
    const delayDir = path.join(testRunsDir, 'run-delay-success');
    const { root: rootDelay, manifest: mDelay } = await download(delayedPolicy, delayDir);
    assert.equal(mDelay.status, 'complete', `delayed element must succeed within budget, got ${mDelay.status}: ${JSON.stringify(mDelay.failures)}`);

    // Negative: assertion for an element that never appears
    const neverPolicy = {
      ...basePolicy,
      required_states: ['never-state'],
      states: [
        {
          state_id: 'never-state',
          name: 'never-state',
          path: '/index.html',
          actions: [{ type: 'click', selector: '#delay-trigger-btn' }],
          assertions: [{ selector: '#never-target-element', visible: true }]
        }
      ]
    };
    const neverDir = path.join(testRunsDir, 'run-never-fail');
    const { root: rootNever, manifest: mNever } = await download(neverPolicy, neverDir);
    assert.notEqual(mNever.status, 'complete', 'element that never appears must fail');
    assert.ok(mNever.failures.some(f => String(f.reason).includes('timed out') || String(f.reason).includes('state_not_reached')), 'expected timeout/state_not_reached for non-existent element');
    console.log('PASS Test 10: Delay handling succeeds and non-existent element fails');

    // -------------------------------------------------------------
    // Test 11: Partial visibility fails min_count
    // -------------------------------------------------------------
    console.log('Test 11: Partial visibility - min_count fails when only first element is visible');
    const partialVisPolicy = {
      ...basePolicy,
      required_states: ['partial-vis-state'],
      states: [
        {
          state_id: 'partial-vis-state',
          name: 'partial-vis-state',
          path: '/index.html',
          actions: [],
          // Selector matches 2 items, but item 2 has display:none; min_count: 2 must fail!
          assertions: [{ selector: '#partial-list .partial-item', visible: true, min_count: 2 }]
        }
      ]
    };
    const partialVisDir = path.join(testRunsDir, 'run-partial-vis');
    const { root: rootPartial, manifest: mPartial } = await download(partialVisPolicy, partialVisDir);
    assert.notEqual(mPartial.status, 'complete', 'partial visibility must not satisfy min_count');
    const hasMinCountError = mPartial.failures.some(f => String(f.reason).includes('expected at least 2 visible items, found 1'));
    assert.ok(hasMinCountError, `expected min_count failure, got: ${JSON.stringify(mPartial.failures)}`);
    console.log('PASS Test 11: Partial visibility fails min_count');

    // -------------------------------------------------------------
    // Test 12: Broken restoration action fails verification
    // -------------------------------------------------------------
    console.log('Test 12: Broken restoration action fails verification');
    const brokenRestorePolicy = {
      ...basePolicy,
      required_states: ['broken-restore-state'],
      states: [
        {
          state_id: 'region-closed',
          name: 'region-closed',
          path: '/index.html',
          actions: [],
          assertions: [
            { selector: '#region-trigger-btn', visible: true },
            { selector: '#region-portal', visible: false }
          ]
        },
        {
          state_id: 'broken-restore-state',
          name: 'broken-restore-state',
          path: '/index.html',
          actions: [
            { type: 'click', selector: '#region-trigger-btn' },
            { type: 'click', selector: '#broken-close-btn' } // Hides trigger button, violating region-closed invariant
          ],
          assertions: [
            { selector: '#region-portal', visible: false }
          ],
          restores_state: 'region-closed'
        }
      ]
    };
    const brokenRestoreDir = path.join(testRunsDir, 'run-broken-restore');
    const { root: rootBrokenRestore, manifest: mBrokenRestore } = await download(brokenRestorePolicy, brokenRestoreDir);
    assert.notEqual(mBrokenRestore.status, 'complete', 'broken restore must fail');
    const hasRestoreError = mBrokenRestore.failures.some(f => String(f.reason).includes('state_restoration_failed'));
    assert.ok(hasRestoreError, `expected state_restoration_failed, got: ${JSON.stringify(mBrokenRestore.failures)}`);
    console.log('PASS Test 12: Broken restoration action fails verification');

    // -------------------------------------------------------------
    // Test 13: Required resource selector not found fails verification
    // -------------------------------------------------------------
    console.log('Test 13: Required resource selector not found fails verification');
    const missingResPolicy = {
      ...basePolicy,
      required_states: ['missing-res-state'],
      states: [
        {
          state_id: 'missing-res-state',
          name: 'missing-res-state',
          path: '/index.html',
          actions: [],
          assertions: [{ selector: '#region-trigger-btn', visible: true }],
          required_resources: [{ selector: '#non-existent-image-icon' }]
        }
      ]
    };
    const missingResDir = path.join(testRunsDir, 'run-missing-res');
    const { root: rootMissingRes, manifest: mMissingRes } = await download(missingResPolicy, missingResDir);
    assert.notEqual(mMissingRes.status, 'complete', 'missing required resource must fail');
    const hasResMissingError = mMissingRes.failures.some(f => String(f.reason).includes('required_resource_missing'));
    assert.ok(hasResMissingError, `expected required_resource_missing, got: ${JSON.stringify(mMissingRes.failures)}`);
    console.log('PASS Test 13: Required resource selector not found fails verification');

    console.log('\nAll 13 state-handoff acceptance tests passed successfully!');
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
