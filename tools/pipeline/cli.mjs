#!/usr/bin/env node
/**
 * Reference Pipeline – CLI
 *
 * Commands:
 *   run      <contract.json> --output <dir> --storage <dir>
 *            Start a fresh pipeline run for a given contract.
 *
 *   resume   <contract.json> --output <dir> --storage <dir> --run-id <id>
 *            Resume an interrupted run. Rejects if contract scope changed.
 *
 *   status   --output <dir> --run-id <id>
 *            Print current pipeline status and stats.
 *
 *   inspect  --output <dir> --run-id <id> [--url <url>] [--state <id>] [--viewport <WxH>]
 *            Locate reference artifacts for a specific page/state/viewport.
 *
 * Exit codes:
 *   0  REFERENCE_READY or TECH_VERIFIED
 *   2  BUDGET_PAUSED or EVIDENCE_INCOMPLETE or INTERACTIONS_PENDING
 *   3  CHALLENGE_BLOCKED
 *   1  Error / unexpected failure
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runPipeline, loadCheckpoint, checkpointPath, STATUS } from './pipeline.mjs';

const EXIT = {
  [STATUS.REFERENCE_READY]:        0,
  [STATUS.TECH_VERIFIED]:          0,
  [STATUS.BUDGET_PAUSED]:          2,
  [STATUS.EVIDENCE_INCOMPLETE]:    2,
  [STATUS.INTERACTIONS_PENDING]:   2,
  [STATUS.CHALLENGE_BLOCKED]:      3,
  [STATUS.CAPTURING]:              2,
};

const USAGE = `
Reference Pipeline CLI

USAGE
  node tools/pipeline/cli.mjs run    <contract.json> --output <dir> --storage <dir> [--budget N]
  node tools/pipeline/cli.mjs resume <contract.json> --output <dir> --storage <dir> --run-id <id> [--budget N]
  node tools/pipeline/cli.mjs status  --output <dir> --run-id <id>
  node tools/pipeline/cli.mjs inspect --output <dir> --run-id <id> [--url <url>] [--state <id>] [--viewport <WxH>]
  node tools/pipeline/cli.mjs --help

OPTIONS
  --output    Base output directory for pipeline captures
  --storage   Crawlee queue persistent storage directory
  --run-id    Run ID (UUID) for resume/status/inspect
  --budget    Max tasks to process in this invocation (default: 50)
  --dry-queue Populate queue only, do not capture (for testing queue logic)
`.trim();

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  if (!['run', 'resume', 'status', 'inspect'].includes(command)) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      output:    { type: 'string' },
      storage:   { type: 'string' },
      'run-id':  { type: 'string' },
      budget:    { type: 'string', default: '50' },
      'dry-queue': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const outputDir = values.output ? path.resolve(values.output) : null;
  const storageDir = values.storage ? path.resolve(values.storage) : null;
  const runId = values['run-id'] || null;
  const maxBudget = parseInt(values.budget, 10) || 50;
  const dryQueue = values['dry-queue'] || false;

  // --- status ---
  if (command === 'status') {
    if (!outputDir || !runId) { console.error('--output and --run-id required for status'); process.exit(1); }
    const cp = loadCheckpoint(checkpointPath(outputDir, runId));
    if (!cp) { console.error(`No checkpoint found for run-id ${runId}`); process.exit(1); }
    const indexPath = path.join(outputDir, runId, 'reference-index.json');
    const index = tryReadJSON(indexPath);
    console.log(JSON.stringify({ runId, checkpoint: cp, pageCount: index?.pageCount ?? 'N/A' }, null, 2));
    process.exit(0);
  }

  // --- inspect ---
  if (command === 'inspect') {
    if (!outputDir || !runId) { console.error('--output and --run-id required for inspect'); process.exit(1); }
    const indexPath = path.join(outputDir, runId, 'reference-index.json');
    const index = tryReadJSON(indexPath);
    if (!index) { console.error('reference-index.json not found'); process.exit(1); }

    const urlFilter = values.url;
    const stateFilter = values.state;
    const vpFilter = values.viewport;

    const results = Object.entries(index.pages)
      .filter(([k, v]) => {
        if (urlFilter && !v.url.includes(urlFilter)) return false;
        if (stateFilter && v.stateId !== stateFilter) return false;
        if (vpFilter && v.viewport !== vpFilter) return false;
        return true;
      })
      .map(([, v]) => v);

    if (results.length === 0) {
      console.log('No matching captures found.');
      process.exit(2);
    }

    for (const r of results) {
      console.log(`\n[${r.stateId} | ${r.viewport}] ${r.url}`);
      console.log(`  Capture dir: ${r.captureDir}`);
      for (const [name, relPath] of Object.entries(r.files || {})) {
        const absPath = path.resolve(r.captureDir, relPath);
        const exists = fs.existsSync(absPath);
        console.log(`  ${name}: ${absPath} [${exists ? 'OK' : 'MISSING'}]`);
      }
    }
    process.exit(0);
  }

  // --- run / resume ---
  const contractPath = positionals[0];
  if (!contractPath) { console.error('Contract JSON path required as first argument'); process.exit(1); }
  if (!outputDir) { console.error('--output is required'); process.exit(1); }
  if (!storageDir) { console.error('--storage is required'); process.exit(1); }

  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(path.resolve(contractPath), 'utf8'));
  } catch (e) {
    console.error(`Failed to read contract: ${e.message}`);
    process.exit(1);
  }

  const isFresh = command === 'run';

  let result;
  try {
    result = await runPipeline(contract, {
      baseOutput: outputDir,
      storageDir,
      runId: command === 'resume' ? runId : undefined,
      fresh: isFresh,
      maxBudget,
      dryQueue,
    });
  } catch (e) {
    console.error(`Pipeline error: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));

  const exitCode = EXIT[result.status] ?? 1;
  process.exit(exitCode);
}

function tryReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

main().catch(e => { console.error(e); process.exit(1); });
