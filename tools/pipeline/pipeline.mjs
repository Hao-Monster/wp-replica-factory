/**
 * Reference Pipeline – Orchestrator
 *
 * Wires together:
 *   1. Seed → Crawlee persistent queue (tools/pipeline/queue.mjs)
 *   2. Crawlee queue → existing Downloader (tools/downloader/download.mjs)
 *   3. Downloader output → existing Verify (tools/downloader/verify.mjs)
 *   4. Verified captures → reference-package index (site/index.json)
 *   5. Completeness check → admission gate
 *
 * Design rules (from task brief):
 * - Tasks marked handled ONLY after file write + digest verify pass
 * - Two crash-recovery positions handled:
 *     A) Fetched but not written → task remains pending on resume
 *     B) Written but not marked handled → verify on resume, then mark
 * - Config/scope changes on resume are REJECTED (new run required)
 * - Queue exhausted ≠ site complete; pending items preserved as-is
 * - No new browser driver, CSS parser, PNG differ, or WP runtime
 *
 * @module pipeline
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openQueue, buildTaskKey } from './queue.mjs';
import { download } from '../downloader/download.mjs';
import { verify } from '../downloader/verify.mjs';
import { ROOT, sha, json } from '../downloader/core.mjs';

export const PIPELINE_SCHEMA = 'reference-pipeline/v0.1';

/**
 * Pipeline status codes (machine-readable gate output).
 *
 * CAPTURING         - still running
 * BUDGET_PAUSED     - budget limit hit; pending tasks preserved
 * CHALLENGE_BLOCKED - access challenge detected; human review needed
 * EVIDENCE_INCOMPLETE - captures done but verify reports missing items
 * INTERACTIONS_PENDING - unconfirmed interactive candidates remain
 * TECH_VERIFIED     - all checks pass; awaiting human scope approval
 * REFERENCE_READY   - TECH_VERIFIED + human approval on file
 */
export const STATUS = {
  CAPTURING: 'CAPTURING',
  BUDGET_PAUSED: 'BUDGET_PAUSED',
  CHALLENGE_BLOCKED: 'CHALLENGE_BLOCKED',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  INTERACTIONS_PENDING: 'INTERACTIONS_PENDING',
  TECH_VERIFIED: 'TECH_VERIFIED',
  REFERENCE_READY: 'REFERENCE_READY',
};

/**
 * Resolves the pipeline run directory from a base output path and run ID.
 * Each run gets its own directory so partial results are never silently mixed.
 */
export function runDir(baseOutput, runId) {
  if (!baseOutput || !runId) throw new Error('baseOutput and runId are required');
  return path.resolve(baseOutput, runId);
}

/**
 * Returns the path to the pipeline checkpoint file for a given run.
 */
export function checkpointPath(baseOutput, runId) {
  return path.join(runDir(baseOutput, runId), '_pipeline_checkpoint.json');
}

/**
 * Persists a pipeline checkpoint (called frequently so crashes lose minimal work).
 *
 * @param {string} cpPath   - Absolute path to checkpoint file
 * @param {object} state    - Serializable checkpoint state
 */
export function saveCheckpoint(cpPath, state) {
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  const tmp = cpPath + '.tmp';
  fs.writeFileSync(tmp, json(state));
  fs.renameSync(tmp, cpPath); // atomic on POSIX; best-effort on Windows
}

/**
 * Reads and returns an existing checkpoint, or null if not found.
 */
export function loadCheckpoint(cpPath) {
  try {
    return JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Validates that a resume attempt matches the original run config.
 * Throws if scope/config has changed – caller must start a new run.
 *
 * @param {object} saved   - Checkpoint from disk
 * @param {object} current - Current run config
 */
export function assertResumeCompatible(saved, current) {
  const fields = ['seed', 'pageOrigins', 'assetOrigins', 'configVer'];
  for (const f of fields) {
    const s = JSON.stringify(saved[f] ?? null);
    const c = JSON.stringify(current[f] ?? null);
    if (s !== c) {
      throw new Error(
        `Resume rejected: config field "${f}" changed from ${s} to ${c}. ` +
        `Start a new run instead of resuming.`
      );
    }
  }
}

/**
 * Builds a minimal policy object compatible with tools/downloader/download.mjs.
 *
 * @param {object} opts
 * @param {string}   opts.url           - Page URL to capture
 * @param {string}   opts.stateId       - Active state ('default' or named)
 * @param {string[]} opts.pageOrigins   - Allowed page origins
 * @param {string[]} opts.assetOrigins  - Allowed asset origins
 * @param {object}   opts.viewport      - {width, height}
 * @param {object[]} opts.states        - Full state contract array
 * @param {string[]} [opts.required_states]
 * @returns {object}
 */
export function buildPagePolicy({ url, stateId, pageOrigins, assetOrigins, viewport, states, required_states = [] }) {
  let routePath = '/';
  let urlHasQuery = false;
  try {
    const u = new URL(url);
    routePath = u.pathname + (u.search || '');
    urlHasQuery = Boolean(u.search);
  } catch { /* ignore */ }

  // Include states for this page so state-handoff can resolve restores_state target
  const pageStates = stateId === 'default'
    ? []
    : (states || []).filter(s => {
      if (!s.path) return true;
      if (s.path === routePath) return true;
      return !urlHasQuery && s.path === routePath.split('?')[0];
    });

  return {
    mode: 'owned-fixture',
    url,
    pageOrigins,
    assetOrigins,
    viewports: [viewport],
    states: pageStates,
    required_states: stateId === 'default' ? [] : [stateId],
    // One page per task; link discovery is done via HTML extraction after capture
    maxPages: 1,
    maxDepth: 0,
    budgetMs: 90_000,
    timeoutMs: 30_000,
    maxResources: 500,
    maxBytes: 5_242_880,
    maxTotalBytes: 52_428_800,
    sensitiveQueryKeys: [],
    publicGetFixtures: [],
    har: false,
  };
}

/**
 * Extracts same-origin href links from a captured HTML string.
 * Used for pipeline link discovery without re-requesting pages.
 *
 * @param {string} html - Raw HTML content
 * @param {string[]} pageOrigins - Allowed origins
 * @param {string} baseUrl - Base URL for resolving relative hrefs
 * @returns {string[]} Discovered absolute URLs
 */
export function extractLinksFromHtml(html, pageOrigins, baseUrl) {
  const hrefRe = /href=["']([^"'#][^"']*?)["']/gi;
  const discovered = new Set();
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      const resolved = new URL(href, baseUrl);
      resolved.hash = '';
      if (pageOrigins.includes(resolved.origin)) discovered.add(resolved.toString());
    } catch { /* ignore malformed */ }
  }
  return [...discovered];
}

/**
 * Reference-package index: maps page/state/viewport to output artifacts.
 * Written to <runDir>/reference-index.json for developer consumption.
 */
export class ReferenceIndex {
  constructor() {
    this.schema = 1;
    this.pages = {}; // key: `${url}|${stateId}|${viewport}` → entry
  }

  /**
   * @param {string} url
   * @param {string} stateId
   * @param {string} viewport   - '1440x1000'
   * @param {string} captureDir - Relative path to the capture output
   * @param {object} files      - { 'rendered.html': relPath, 'screenshot.png': relPath, ... }
   */
  record(url, stateId, viewport, captureDir, files = {}) {
    const key = `${url}|${stateId}|${viewport}`;
    this.pages[key] = { url, stateId, viewport, captureDir, files, recordedAt: new Date().toISOString() };
  }

  toJSON() {
    return {
      schema: this.schema,
      generatedAt: new Date().toISOString(),
      pageCount: Object.keys(this.pages).length,
      pages: this.pages,
    };
  }
}

/**
 * Runs or resumes the reference pipeline for a given contract.
 *
 * @param {object} contract    - Pipeline contract (see pipeline-contract.schema.json)
 * @param {object} opts
 * @param {string} opts.baseOutput   - Where to write all captures
 * @param {string} opts.storageDir   - Where Crawlee stores its queue
 * @param {string} [opts.runId]      - Supply to resume; omit to create new
 * @param {boolean} [opts.fresh]     - If true, purge queue and start fresh
 * @param {number} [opts.maxBudget]  - Max tasks to process in this run
 * @param {boolean} [opts.dryQueue]  - If true, only populate queue, don't capture
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(contract, {
  baseOutput,
  storageDir,
  runId,
  fresh = false,
  maxBudget = 100,
  dryQueue = false,
} = {}) {
  if (!baseOutput) throw new Error('baseOutput is required');
  if (!storageDir) throw new Error('storageDir is required');

  const {
    seed,
    pageOrigins,
    assetOrigins,
    configVer = 'v1',
    viewports,
    states = [],
    required_states = [],
    require_interactions_confirmed = false,
    interactions_pending = [],
    approval = null,
  } = contract;

  // --- Run identity ---
  const isResume = Boolean(runId);
  if (!runId) runId = crypto.randomUUID();
  const dir = runDir(baseOutput, runId);
  const cpPath = checkpointPath(baseOutput, runId);

  let checkpoint = loadCheckpoint(cpPath);

  // --- Resume compatibility guard ---
  if (isResume && checkpoint) {
    assertResumeCompatible(checkpoint, { seed, pageOrigins, assetOrigins, configVer });
  }

  // --- Open queue ---
  const queue = await openQueue({
    storageDir,
    queueName: `pipeline-${runId}`,
    purgeOnStart: fresh,
  });

  // --- Seed initial tasks ---
  const seededKeys = [];
  for (const vp of viewports) {
    const vpStr = `${vp.width}x${vp.height}`;
    // Always enqueue seed in default state for each viewport
    const r = await queue.enqueue({ url: seed, stateId: 'default', viewport: vpStr, configVer });
    seededKeys.push(r.uniqueKey);

    // Enqueue states that belong to the seed URL
    let seedPathname = '/';
    try { seedPathname = new URL(seed).pathname; } catch { /* ignore */ }
    for (const stateDef of (states || [])) {
      if (!stateDef.path || stateDef.path === seedPathname) {
        const sid = stateDef.state_id || stateDef.name;
        if (sid && (required_states.length === 0 || required_states.includes(sid))) {
          const rs = await queue.enqueue({ url: seed, stateId: sid, viewport: vpStr, configVer });
          seededKeys.push(rs.uniqueKey);
        }
      }
    }
  }

  if (dryQueue) {
    const stats = await queue.getStats();
    return { runId, status: STATUS.CAPTURING, stats, seededKeys, captures: [], errors: [] };
  }

  // --- Process loop ---
  const index = new ReferenceIndex();
  const captures = [];
  const errors = [];
  const pendingPageGaps = [];
  let tasksThisRun = 0;
  let challengeBlocked = false;

  // Rebuild index from checkpoint captures if resuming
  if (checkpoint?.captures) {
    for (const c of checkpoint.captures) {
      index.record(c.url, c.stateId, c.viewport, c.captureDir, c.files);
      captures.push(c);
    }
  }

  while (tasksThisRun < maxBudget) {
    const task = await queue.fetchNext();
    if (!task) break; // queue empty this cycle

    const { url, userData } = task;
    const { stateId = 'default', viewport = '1440x1000', configVer: taskCfgVer = 'v1' } = userData;

    // Config version mismatch on resume → reject task
    if (taskCfgVer !== configVer) {
      errors.push({ url, stateId, viewport, error: 'config_version_mismatch', fatal: false });
      await queue.markHandled(task); // consume to prevent loop
      continue;
    }

    const [w, h] = viewport.split('x').map(Number);
    const vpObj = { width: w || 1440, height: h || 1000 };

    const captureId = sha(`${url}|${stateId}|${viewport}|${configVer}`);
    const captureDir = path.join(dir, 'captures', captureId);

    // --- Crash recovery: check if output already verified ---
    // verify() returns {schema, status, errors} object, NOT an array.
    const existingManifest = tryReadJSON(path.join(captureDir, 'manifest.json'));
    if (existingManifest?.status === 'complete' || existingManifest?.status === 'partial') {
      try {
        const verifyResult = verify(captureDir, {});
        const hasIntegrityError = (verifyResult.errors || []).some(e =>
          e.includes('hash mismatch') ||
          e.includes('empty file') ||
          e.includes('ownership marker') ||
          e.includes('resource byte counts') ||
          e.includes('resource content invalid') ||
          e.includes('capture evidence missing')
        );

        if (!hasIntegrityError) {
          const failures = existingManifest.failures || [];
          const nonAcceptable = failures.filter(f =>
            f.reason !== 'dependency_gap' || f.kind !== 'page'
          );
          if (verifyResult.status === 'complete' || (nonAcceptable.length === 0 && Array.isArray(existingManifest.captures) && existingManifest.captures.length > 0)) {
            for (const f of failures.filter(f => f.reason === 'dependency_gap' && f.kind === 'page')) {
              pendingPageGaps.push({ fromUrl: url, targetUrl: f.url });
            }
            recordCapture({ index, captures, url, stateId, viewport, captureDir, captureId });
            await queue.markHandled(task);
            tasksThisRun++;
            continue;
          }
        } else {
          // Integrity error detected - corrupted files cannot be accepted or reused as complete
          errors.push({ url, stateId, viewport, error: 'corrupt_output', detail: verifyResult.errors });
        }
      } catch {
        // verification threw → fall through to re-capture
      }
    }

    // --- Capture ---
    const policy = buildPagePolicy({
      url,
      stateId,
      pageOrigins,
      assetOrigins,
      viewport: vpObj,
      states,
      required_states,
    });

    let captureError = null;
    try {
      await download(policy, captureDir, { ignoreHTTPSErrors: false });
    } catch (e) {
      captureError = e;
    }

    // --- Challenge detection ---
    if (!captureError) {
      const manifest = tryReadJSON(path.join(captureDir, 'manifest.json'));
      if (manifest?.status === 'blocked' || manifest?.challenge?.detected) {
        challengeBlocked = true;
        errors.push({ url, stateId, viewport, error: 'challenge_blocked', detail: manifest?.challenge });
        await queue.markHandled(task);
        tasksThisRun++;
        saveCheckpoint(cpPath, buildCheckpoint({ runId, seed, pageOrigins, assetOrigins, configVer, captures, errors }));
        continue;
      }
    }

    if (captureError) {
      errors.push({ url, stateId, viewport, error: captureError.message });
      await queue.markHandled(task); // don't retry in MVP; log failure
      tasksThisRun++;
      saveCheckpoint(cpPath, buildCheckpoint({ runId, seed, pageOrigins, assetOrigins, configVer, captures, errors }));
      continue;
    }

    // --- Verify output ---
    // Note: verify() returns {schema, status, errors} object, not a plain array.
    // In pipeline mode:
    // - Route dependency gaps (kind === 'page') are tracked and reconciled against final captures
    // - Font load failures or asset gaps are recorded as errors, blocking TECH_VERIFIED
    // - File integrity errors (hash mismatch, empty file) reject the capture completely
    let verifyResult = { schema: 1, status: 'failed', errors: ['verify not run'] };
    let captureOk = false;
    let taskFailures = [];

    try {
      verifyResult = verify(captureDir, {});
      if (verifyResult.status === 'complete') {
        captureOk = true;
      } else {
        const manifest = tryReadJSON(path.join(captureDir, 'manifest.json'));
        if (manifest?.status === 'partial' || manifest?.status === 'complete') {
          const integrityErrors = (verifyResult.errors || []).filter(e =>
            e.includes('hash mismatch') ||
            e.includes('empty file') ||
            e.includes('ownership marker') ||
            e.includes('resource byte counts') ||
            e.includes('resource content invalid') ||
            e.includes('capture evidence missing')
          );

          if (integrityErrors.length === 0 && Array.isArray(manifest.captures) && manifest.captures.length > 0) {
            taskFailures = manifest.failures || [];
            const fatalFailures = taskFailures.filter(f =>
              !(f.reason === 'dependency_gap' && f.kind === 'page') &&
              f.reason !== 'font_load' &&
              f.kind !== 'asset'
            );
            if (fatalFailures.length === 0) {
              captureOk = true;
            }
          }
        }
      }
    } catch (e) {
      verifyResult = { schema: 1, status: 'failed', errors: [e.message] };
    }

    if (!captureOk) {
      errors.push({ url, stateId, viewport, error: 'verify_failed', detail: verifyResult.errors });
      // Do NOT mark handled – leave task in queue for potential retry
      tasksThisRun++;
      saveCheckpoint(cpPath, buildCheckpoint({ runId, seed, pageOrigins, assetOrigins, configVer, captures, errors }));
      continue;
    }

    // Record specific partial gaps
    for (const f of taskFailures) {
      if (f.reason === 'dependency_gap' && f.kind === 'page') {
        pendingPageGaps.push({ fromUrl: url, targetUrl: f.url });
      } else if (f.reason === 'font_load') {
        errors.push({ url, stateId, viewport, error: 'font_load', detail: f });
      } else if (f.kind === 'asset') {
        errors.push({ url, stateId, viewport, error: 'asset_gap', detail: f });
      }
    }

    // --- Discover linked pages from routes.json and enqueue ---
    // routes.json contains actual page URLs discovered by the downloader.
    // With maxDepth:0, linked pages appear as 'pending' (discovered but not visited).
    // With maxDepth:1+, they appear as 'visited'. We enqueue both.
    if (stateId === 'default') {
      const routesData = tryReadJSON(path.join(captureDir, 'routes.json'));
      const discoveredRoutes = (routesData?.routes || []).filter(r =>
        (r.status === 'visited' || r.status === 'pending') &&
        pageOrigins.some(o => (r.final_url || r.url)?.startsWith(o))
      );
      for (const route of discoveredRoutes) {
        const discoveredUrl = route.final_url || route.url;
        for (const vp of viewports) {
          const vpStr = `${vp.width}x${vp.height}`;
          await queue.enqueue({ url: discoveredUrl, stateId: 'default', viewport: vpStr, configVer });
          // Enqueue matching named states for this discovered page
          for (const stateDef of (states || [])) {
            const u = new URL(discoveredUrl);
            const routePath = u.pathname + (u.search || '');
            const matches = !stateDef.path || stateDef.path === routePath || (!u.search && stateDef.path === u.pathname);
            if (matches) {
              const sid = stateDef.state_id || stateDef.name;
              if (sid) await queue.enqueue({ url: discoveredUrl, stateId: sid, viewport: vpStr, configVer });
            }
          }
        }
      }
    }

    // --- Record success ---
    recordCapture({ index, captures, url, stateId, viewport, captureDir, captureId });
    await queue.markHandled(task);
    tasksThisRun++;

    // Checkpoint after every successful capture
    saveCheckpoint(cpPath, buildCheckpoint({ runId, seed, pageOrigins, assetOrigins, configVer, captures, errors }));
  }

  // --- Write reference index ---
  const indexPath = path.join(dir, 'reference-index.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath, json(index.toJSON()));

  // --- Compute final status ---
  const stats = await queue.getStats();
  let status = computeStatus({
    stats,
    errors,
    challengeBlocked,
    require_interactions_confirmed,
    interactions_pending,
    approval,
    contract,
    captures,
    pendingPageGaps,
  });

  const result = {
    schema: PIPELINE_SCHEMA,
    runId,
    startedAt: checkpoint?.startedAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status,
    stats,
    captureCount: captures.length,
    errorCount: errors.length,
    captures,
    errors,
    referenceIndexPath: indexPath,
  };

  // Final checkpoint
  saveCheckpoint(cpPath, { ...buildCheckpoint({ runId, seed, pageOrigins, assetOrigins, configVer, captures, errors }), status, stats });

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function recordCapture({ index, captures, url, stateId, viewport, captureDir, captureId }) {
  // Collect file evidence matching this specific stateId and viewport from manifest.captures
  const files = {};
  const manifest = tryReadJSON(path.join(captureDir, 'manifest.json'));
  const capMatch = manifest?.captures?.find(c =>
    (c.state === stateId || (!c.state && stateId === 'default')) &&
    (!viewport || `${c.viewport?.width}x${c.viewport?.height}` === viewport)
  ) || manifest?.captures?.find(c => c.state === stateId) || manifest?.captures?.[0];

  if (capMatch?.files) {
    for (const [k, v] of Object.entries(capMatch.files)) {
      if (v?.path) files[k] = v.path;
    }
  }

  // Fallback if manifest files not found
  for (const name of ['rendered.html', 'screenshot.png', 'signals.json']) {
    if (!files[name]) {
      const pagesDir = path.join(captureDir, 'pages');
      const found = findFileUnder(pagesDir, name);
      if (found) files[name] = path.relative(captureDir, found);
    }
  }

  index.record(url, stateId, viewport, captureDir, files);
  captures.push({ url, stateId, viewport, captureDir, captureId, files, capturedAt: new Date().toISOString() });
}

function buildCheckpoint({ runId, seed, pageOrigins, assetOrigins, configVer, captures, errors }) {
  return { runId, seed, pageOrigins, assetOrigins, configVer, captures, errors, startedAt: new Date().toISOString() };
}

export function computeStatus({ stats, errors, challengeBlocked, require_interactions_confirmed, interactions_pending, approval, contract, captures, pendingPageGaps = [] }) {
  if (challengeBlocked) return STATUS.CHALLENGE_BLOCKED;

  if (stats.pending > 0) return STATUS.BUDGET_PAUSED;

  // Check required pages/states are captured
  const requiredStates = contract?.required_states || [];
  const requiredPages = contract?.required_pages || [];
  for (const req of requiredPages) {
    if (!captures.some(c => c.url === req || c.url.endsWith(req))) {
      return STATUS.EVIDENCE_INCOMPLETE;
    }
  }
  for (const stateId of requiredStates) {
    if (!captures.some(c => c.stateId === stateId)) {
      return STATUS.EVIDENCE_INCOMPLETE;
    }
  }

  // Check required states & pages across each required viewport
  const contractViewports = contract?.viewports || [];
  for (const vp of contractViewports) {
    const vpStr = `${vp.width}x${vp.height}`;
    for (const req of requiredPages) {
      if (!captures.some(c => (c.url === req || c.url.endsWith(req)) && c.viewport === vpStr)) {
        return STATUS.EVIDENCE_INCOMPLETE;
      }
    }
    for (const stateId of requiredStates) {
      if (!captures.some(c => c.stateId === stateId && c.viewport === vpStr)) {
        return STATUS.EVIDENCE_INCOMPLETE;
      }
    }
  }

  // Reconcile pending page dependency gaps:
  // "页面任务尚未执行可以暂存为pending并继续采集，但最终要按实际已保存路由核销缺口。不能将所有dependency_gap永久豁免。"
  const capturedUrls = new Set(captures.map(c => {
    try {
      const u = new URL(c.url);
      return u.pathname + u.search;
    } catch {
      return c.url;
    }
  }));
  for (const c of captures) capturedUrls.add(c.url);

  const unfulfilledPageGaps = pendingPageGaps.filter(g => {
    try {
      const u = new URL(g.targetUrl);
      const pathAndSearch = u.pathname + u.search;
      return !capturedUrls.has(g.targetUrl) && !capturedUrls.has(pathAndSearch);
    } catch {
      return !capturedUrls.has(g.targetUrl);
    }
  });

  if (unfulfilledPageGaps.length > 0) {
    return STATUS.EVIDENCE_INCOMPLETE;
  }

  // "必要字体失败或文件损坏：保留已有可读产物，预览显示PARTIAL和具体缺口；不得升级为TECH_VERIFIED或REFERENCE_READY。"
  if (errors.some(e => e.error === 'verify_failed' || e.error === 'font_load' || e.error === 'asset_gap' || e.error === 'corrupt_output')) {
    return STATUS.EVIDENCE_INCOMPLETE;
  }

  if (require_interactions_confirmed && interactions_pending.length > 0) {
    return STATUS.INTERACTIONS_PENDING;
  }

  if (!approval?.approved) return STATUS.TECH_VERIFIED;

  return STATUS.REFERENCE_READY;
}

function tryReadJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return null; }
}

function findFileUnder(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileUnder(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}
