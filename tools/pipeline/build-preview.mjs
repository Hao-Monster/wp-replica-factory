#!/usr/bin/env node
/**
 * Reference Pipeline – Automated Preview Builder
 *
 * Runs an isolated capture against the owned pipeline-site fixture
 * and exports the static preview to dist-preview/ for GitHub Pages.
 *
 * Can be run locally or in GitHub Actions CI.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runPipeline, STATUS } from './pipeline.mjs';
import { exportPreview } from './export-preview.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ROOT_DIR, 'tests/fixtures/pipeline-site');
const CONTRACT_TEMPLATE_PATH = path.join(FIXTURE_DIR, 'pipeline-contract.json');

const MIME_TYPES = {
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

function startFixtureServer() {
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
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      console.log(`[build-preview] Fixture server started at: ${origin}`);
      resolve({
        server,
        origin,
        close: () => new Promise(res => { server.closeAllConnections(); server.close(res); }),
      });
    });
    server.on('error', reject);
  });
}

export async function buildAndExport({ outputDir = 'dist-preview', sha, runId } = {}) {
  const startTime = Date.now();
  console.log(`[build-preview] Starting preview build pipeline...`);

  const workDir = path.join(ROOT_DIR, '.replica', 'preview-build-' + Date.now());
  const captureOutputDir = path.join(workDir, 'output');
  const storageDir = path.join(workDir, 'queue');
  const distDir = path.resolve(ROOT_DIR, outputDir);

  const { origin, close } = await startFixtureServer();

  try {
    // 1. Build contract with dynamic fixture origin
    const rawContract = fs.readFileSync(CONTRACT_TEMPLATE_PATH, 'utf8');
    const contract = JSON.parse(
      rawContract.replaceAll('<<REPLACED_AT_RUNTIME_WITH_SERVER_ORIGIN>>', origin)
    );

    // Save runtime contract
    const runtimeContractPath = path.join(workDir, 'runtime-contract.json');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(runtimeContractPath, JSON.stringify(contract, null, 2));

    console.log(`[build-preview] Running pipeline capture...`);
    const pipelineResult = await runPipeline(contract, {
      baseOutput: captureOutputDir,
      storageDir,
      fresh: true,
      maxBudget: 40,
    });

    console.log(`[build-preview] Pipeline completed with status: ${pipelineResult.status}`);
    console.log(`[build-preview] Captured tasks: ${pipelineResult.captureCount}, Errors: ${pipelineResult.errorCount}`);

    // Close fixture server before exporting to prove static independence
    await close();
    console.log(`[build-preview] Fixture server stopped.`);

    // 2. Export static preview
    const exportResult = exportPreview({
      inputDir: captureOutputDir,
      outputDir: distDir,
      contractPath: runtimeContractPath,
      sourceSha: sha || process.env.GITHUB_SHA || 'HEAD',
      runId: runId || process.env.GITHUB_RUN_ID || pipelineResult.runId,
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[build-preview] Preview build finished in ${elapsedSec}s!`);

    return {
      status: pipelineResult.status,
      captureCount: pipelineResult.captureCount,
      errorCount: pipelineResult.errorCount,
      distDir,
      elapsedSec,
      runId: pipelineResult.runId,
      previewManifest: exportResult.previewManifest,
    };
  } catch (err) {
    await close().catch(() => {});
    throw err;
  } finally {
    // Clean up temporary work directory to keep workspace tidy
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// CLI invocation
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', short: 'o', default: 'dist-preview' },
      sha: { type: 'string' },
      'run-id': { type: 'string' },
    },
  });

  buildAndExport({
    outputDir: values.output,
    sha: values.sha,
    runId: values['run-id'],
  }).then(res => {
    console.log(`[build-preview] Result: ${res.status}, Artifacts at: ${res.distDir}`);
  }).catch(err => {
    console.error(`[build-preview] Fatal:`, err);
    process.exit(1);
  });
}
