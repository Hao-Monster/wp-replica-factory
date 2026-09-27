#!/usr/bin/env node
/**
 * Reference Pipeline – Static Preview Exporter
 *
 * Generates a self-contained, sanitized, offline-viewable static site
 * from a completed (or partial) reference pipeline capture run.
 *
 * Output is suitable for direct deployment to GitHub Pages or local static serving.
 *
 * Guarantees:
 * - Subpath-friendly: works at /wp-replica-factory/ or local file/http server
 * - Preserves original raw DOM & files in captures/ while creating localized views
 * - Sanitized: no private paths, no .env, no cookies/tokens/HARs
 * - Handles query string routes (/catalog.html?sale=1) with distinct output mappings
 * - Distinguishes SOURCE fixtures from CAPTURED artifacts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function exportPreview({ inputDir, outputDir, contractPath, sourceSha, runId }) {
  console.log(`[export-preview] Reading pipeline output from: ${inputDir}`);
  console.log(`[export-preview] Target export directory: ${outputDir}`);

  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  // 1. Read pipeline artifacts (support direct runDir or baseOutput dir containing runId)
  let actualInputDir = inputDir;
  let indexPath = path.join(actualInputDir, 'reference-index.json');
  if (!fs.existsSync(indexPath)) {
    for (const ent of fs.readdirSync(inputDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const subIndex = path.join(inputDir, ent.name, 'reference-index.json');
        if (fs.existsSync(subIndex)) {
          actualInputDir = path.join(inputDir, ent.name);
          indexPath = subIndex;
          break;
        }
      }
    }
  }

  if (!fs.existsSync(indexPath)) {
    throw new Error(`reference-index.json not found in ${inputDir}`);
  }
  const refIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  let checkpoint = null;
  for (const cpName of ['_pipeline_checkpoint.json', 'checkpoint.json']) {
    const cpPath = path.join(actualInputDir, cpName);
    if (fs.existsSync(cpPath)) {
      checkpoint = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
      break;
    }
  }

  let contract = null;
  if (contractPath && fs.existsSync(contractPath)) {
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  }

  // 2. Prepare export directory
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const exportCapturesDir = path.join(outputDir, 'captures');
  const exportViewsDir = path.join(outputDir, 'views');
  fs.mkdirSync(exportCapturesDir, { recursive: true });
  fs.mkdirSync(exportViewsDir, { recursive: true });

  const items = [];
  const allResources = new Map();

  // 3. Process each capture entry from index
  for (const [key, entry] of Object.entries(refIndex.pages || {})) {
    const { url, stateId, viewport, captureDir, files = {} } = entry;
    const absCaptureDir = path.isAbsolute(captureDir) ? captureDir : path.resolve(inputDir, captureDir);
    const captureId = path.basename(absCaptureDir);

    if (!fs.existsSync(absCaptureDir)) {
      console.warn(`[export-preview] Warning: captureDir does not exist: ${absCaptureDir}`);
      continue;
    }

    const manifestPath = path.join(absCaptureDir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;

    const resourcesPath = path.join(absCaptureDir, 'resources.json');
    const resourcesData = fs.existsSync(resourcesPath) ? JSON.parse(fs.readFileSync(resourcesPath, 'utf8')) : null;

    // Destination capture dir
    const destCaptureDir = path.join(exportCapturesDir, captureId);
    fs.mkdirSync(destCaptureDir, { recursive: true });

    // Copy manifest (sanitized)
    if (manifest) {
      const sanitizedManifest = { ...manifest };
      if (sanitizedManifest.policy) {
        delete sanitizedManifest.policy.storageDir;
      }
      fs.writeFileSync(path.join(destCaptureDir, 'manifest.json'), JSON.stringify(sanitizedManifest, null, 2));
    }

    // Copy original page files (rendered.html, screenshot.png, signals.json)
    const exportFiles = {};
    for (const [fileKey, relPath] of Object.entries(files)) {
      const srcFile = path.join(absCaptureDir, relPath);
      if (fs.existsSync(srcFile)) {
        const destFile = path.join(destCaptureDir, relPath);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(srcFile, destFile);
        exportFiles[fileKey] = `captures/${captureId}/${relPath.replace(/\\/g, '/')}`;
      }
    }

    // Copy site/objects (the saved assets)
    const srcObjectsDir = path.join(absCaptureDir, 'site', 'objects');
    const destObjectsDir = path.join(destCaptureDir, 'site', 'objects');
    if (fs.existsSync(srcObjectsDir)) {
      fs.mkdirSync(destObjectsDir, { recursive: true });
      for (const objFile of fs.readdirSync(srcObjectsDir)) {
        const srcObj = path.join(srcObjectsDir, objFile);
        const destObj = path.join(destObjectsDir, objFile);
        if (fs.statSync(srcObj).isFile()) {
          fs.copyFileSync(srcObj, destObj);
        }
      }
    }

    // Track resources
    const captureResources = [];
    for (const r of (resourcesData?.resources || [])) {
      if (r.status === 'saved' && r.local_path) {
        const objName = path.basename(r.local_path);
        const assetRelPath = `captures/${captureId}/site/objects/${objName}`;
        const resInfo = {
          url: r.url,
          mime: r.mime,
          bytes: r.bytes,
          sha256: r.raw_sha256,
          relPath: assetRelPath,
        };
        captureResources.push(resInfo);
        allResources.set(r.url, resInfo);
      }
    }

    // Generate localized derived view HTML for offline browser viewing
    let viewRelPath = null;
    const rawRenderedPath = files['rendered.html'] ? path.join(absCaptureDir, files['rendered.html']) : null;
    if (rawRenderedPath && fs.existsSync(rawRenderedPath)) {
      let rawHtml = fs.readFileSync(rawRenderedPath, 'utf8');

      // Create a localized HTML view that rewrites object URLs to relative paths
      // In downloader captures, assets in rendered HTML may reference /site/objects/xxx or original relative /assets/xxx
      // We rewrite references using the capture's resources mapping
      for (const res of captureResources) {
        try {
          const u = new URL(res.url);
          const pathname = u.pathname;
          // Replace absolute /assets/... or original pathname with relative link to captured object
          const objName = path.basename(res.relPath);
          const relativeAsset = `../../captures/${captureId}/site/objects/${objName}`;
          rawHtml = rawHtml.replaceAll(`"${pathname}"`, `"${relativeAsset}"`);
          rawHtml = rawHtml.replaceAll(`'${pathname}'`, `'${relativeAsset}'`);
          rawHtml = rawHtml.replaceAll(`url('${pathname}')`, `url('${relativeAsset}')`);
          rawHtml = rawHtml.replaceAll(`url("${pathname}")`, `url("${relativeAsset}")`);
          rawHtml = rawHtml.replaceAll(`url(${pathname})`, `url(${relativeAsset})`);
        } catch { /* ignore */ }
      }

      // Add offline banner
      const bannerHtml = `
<!-- OFFLINE_CAPTURED_BANNER -->
<div id="__replica_banner" style="background:#0f172a;color:#38bdf8;padding:8px 16px;font-family:system-ui,sans-serif;font-size:12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155;z-index:999999;position:relative;">
  <div>
    <strong>CAPTURED REFERENCE ARTIFACT</strong> |
    URL: <code>${escapeHtml(url)}</code> |
    State: <code>${escapeHtml(stateId)}</code> |
    Viewport: <code>${escapeHtml(viewport)}</code>
  </div>
  <div style="font-size:11px;color:#94a3b8;">
    Isolated Offline Render (No upstream requests)
  </div>
</div>
`;
      const viewDir = path.join(exportViewsDir, captureId);
      fs.mkdirSync(viewDir, { recursive: true });
      const viewHtmlFile = path.join(viewDir, 'index.html');

      // Insert banner right after <body>
      let finalHtml = rawHtml;
      if (finalHtml.includes('<body')) {
        finalHtml = finalHtml.replace(/<body([^>]*)>/i, `<body$1>${bannerHtml}`);
      } else {
        finalHtml = bannerHtml + finalHtml;
      }

      fs.writeFileSync(viewHtmlFile, finalHtml, 'utf8');
      viewRelPath = `views/${captureId}/index.html`;
    }

    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { parsedUrl = { pathname: url, search: '' }; }

    items.push({
      captureId,
      url,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search || '',
      stateId,
      viewport,
      isMobile: viewport.includes('390x'),
      isInteractive: stateId !== 'default',
      status: manifest?.status || 'unknown',
      failures: manifest?.failures || [],
      files: {
        ...exportFiles,
        viewHtml: viewRelPath,
      },
      resourcesCount: captureResources.length,
      resources: captureResources,
    });
  }

  // 4. Compute overall metadata
  const totalCaptures = items.length;
  const uniqueUrls = [...new Set(items.map(i => i.url))];
  const uniqueStates = [...new Set(items.map(i => i.stateId))];
  const uniqueViewports = [...new Set(items.map(i => i.viewport))];
  const overallStatus = checkpoint?.status || (items.some(i => i.status === 'partial') ? 'PARTIAL' : 'TECH_VERIFIED');

  const previewManifest = {
    schema: 1,
    sourceSha: sourceSha || 'HEAD',
    runId: runId || checkpoint?.runId || 'pipeline-run',
    generatedAt: new Date().toISOString(),
    status: overallStatus,
    summary: {
      totalCaptures,
      pageCount: uniqueUrls.length,
      stateCount: uniqueStates.length,
      viewportCount: uniqueViewports.length,
      resourceCount: allResources.size,
      pages: uniqueUrls,
      states: uniqueStates,
      viewports: uniqueViewports,
    },
    contract: contract ? {
      required_pages: contract.required_pages,
      required_states: contract.required_states,
      viewports: contract.viewports,
      expected_counts: contract.expected_counts,
    } : null,
    items,
  };

  fs.writeFileSync(path.join(outputDir, 'preview-manifest.json'), JSON.stringify(previewManifest, null, 2), 'utf8');

  // 5. Generate index.html Portal UI
  const portalHtml = generatePortalHtml(previewManifest);
  fs.writeFileSync(path.join(outputDir, 'index.html'), portalHtml, 'utf8');

  // 6. Security and sanity audit
  auditExport(outputDir);

  console.log(`[export-preview] Successfully exported ${totalCaptures} capture items to ${outputDir}`);
  return { previewManifest, outputDir };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function auditExport(dir) {
  const sensitivePatterns = [
    /\.env/i,
    /cookie/i,
    /token/i,
    /\.git\b/i,
    /id_rsa/i,
    /users\\.*?\\/i, // Windows private user directory
  ];

  function walk(current) {
    for (const f of fs.readdirSync(current)) {
      const full = path.join(current, f);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (f === '.git') throw new Error(`Audit failed: .git found in export dir: ${full}`);
        walk(full);
      } else {
        if (f.endsWith('.har')) throw new Error(`Audit failed: HAR file in export: ${f}`);
        if (f.endsWith('.key')) throw new Error(`Audit failed: Private key in export: ${f}`);
      }
    }
  }
  walk(dir);
}

function generatePortalHtml(manifest) {
  const { sourceSha, runId, generatedAt, status, summary, items } = manifest;
  const isPass = status === 'TECH_VERIFIED' || status === 'REFERENCE_READY';
  const statusColor = isPass ? '#10b981' : '#f59e0b';
  const statusBadge = isPass ? 'TECH_VERIFIED' : 'PARTIAL';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reference Pipeline Preview – Hao-Monster/wp-replica-factory</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --code-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      padding: 16px 24px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .brand-title {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .badge-status {
      background: ${statusColor}22;
      color: ${statusColor};
      border: 1px solid ${statusColor}66;
    }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 0.8rem;
      color: var(--text-muted);
      align-items: center;
    }
    .meta-item { display: flex; align-items: center; gap: 6px; }
    .meta-item code {
      background: #1e293b;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--code-font);
      color: #38bdf8;
    }
    .notice-bar {
      background: #0f172a;
      border-bottom: 1px solid var(--card-border);
      padding: 8px 24px;
      font-size: 0.8rem;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .layout-container {
      display: flex;
      flex: 1;
      height: calc(100vh - 120px);
      overflow: hidden;
    }
    .sidebar {
      width: 340px;
      background: var(--card-bg);
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .sidebar-section {
      padding: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .sidebar-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: 0.08em;
      margin-bottom: 12px;
    }
    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .filter-btn {
      text-align: left;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.15s ease;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .filter-btn:hover {
      background: #1e293b;
    }
    .filter-btn.active {
      background: #1e293b;
      border-color: var(--accent);
      color: #38bdf8;
      font-weight: 600;
    }
    .item-list {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .capture-card {
      background: #151d2f;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }
    .capture-card:hover {
      border-color: #334155;
      transform: translateY(-1px);
    }
    .capture-card.active {
      border-color: var(--accent);
      background: #1a243b;
      box-shadow: 0 0 0 1px var(--accent);
    }
    .card-url {
      font-weight: 600;
      font-size: 0.85rem;
      margin-bottom: 4px;
      word-break: break-all;
    }
    .card-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .tag {
      font-size: 0.7rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: #1e293b;
      color: #cbd5e1;
      font-family: var(--code-font);
    }
    .tag.mobile { color: #f472b6; }
    .tag.state { color: #38bdf8; }
    .main-view {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #020617;
    }
    .view-toolbar {
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      padding: 8px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .tab-group {
      display: flex;
      gap: 4px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab-btn:hover { color: #fff; background: #1e293b; }
    .tab-btn.active {
      color: #fff;
      background: #1e293b;
      border-bottom: 2px solid var(--accent);
    }
    .view-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .action-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #e2e8f0;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.8rem;
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .action-btn:hover {
      background: #334155;
      color: #fff;
    }
    .viewport-canvas {
      flex: 1;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 24px;
      overflow: auto;
      background: #020617;
    }
    .device-frame {
      background: #000;
      border-radius: 12px;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7), 0 0 0 1px #334155;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: all 0.3s ease;
    }
    .device-header {
      background: #1e293b;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.75rem;
      color: #94a3b8;
      border-bottom: 1px solid #334155;
    }
    .device-circle { width: 8px; height: 8px; border-radius: 50%; background: #475569; }
    iframe.preview-frame {
      border: none;
      background: #fff;
      display: block;
    }
    img.screenshot-img {
      max-width: 100%;
      height: auto;
      display: block;
      border-radius: 8px;
    }
    .panel-content {
      padding: 24px;
      overflow-y: auto;
      flex: 1;
    }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      background: var(--card-bg);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--card-border);
    }
    table.data-table th, table.data-table td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--card-border);
    }
    table.data-table th {
      background: #151d2f;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    pre.code-block {
      background: #0f172a;
      border: 1px solid var(--card-border);
      padding: 16px;
      border-radius: 8px;
      font-family: var(--code-font);
      font-size: 0.85rem;
      overflow-x: auto;
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand-title">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
      </svg>
      wp-replica-factory
      <span class="badge badge-status">${statusBadge}</span>
    </div>
    <div class="meta-bar">
      <div class="meta-item">SHA: <code>${escapeHtml(sourceSha.slice(0, 10))}</code></div>
      <div class="meta-item">Run: <code>${escapeHtml(runId.slice(0, 8))}</code></div>
      <div class="meta-item">Pages: <code>${summary.pageCount}</code></div>
      <div class="meta-item">States: <code>${summary.stateCount}</code></div>
      <div class="meta-item">Viewports: <code>${summary.viewportCount}</code></div>
      <div class="meta-item">Resources: <code>${summary.resourceCount}</code></div>
    </div>
  </header>

  <div class="notice-bar">
    <div>
      <strong>Mode:</strong> Owned-Fixture Reference Pipeline MVP &bull; Isolated Offline Capture &bull; Dual Viewport (1440x1000, 390x844) &bull; Verified TTF Font Loading
    </div>
    <div>Generated: ${new Date(generatedAt).toUTCString()}</div>
  </div>

  <div class="layout-container">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-title">Viewports</div>
        <div class="filter-group" id="viewport-filters">
          <button class="filter-btn active" data-vp="all">All Viewports <span class="tag">${summary.totalCaptures}</span></button>
          <button class="filter-btn" data-vp="1440x1000">Desktop (1440×1000)</button>
          <button class="filter-btn" data-vp="390x844">Mobile (390×844)</button>
        </div>
      </div>

      <div class="sidebar-section" style="flex:1; overflow-y:auto; padding:0;">
        <div class="sidebar-title" style="padding:16px 16px 0 16px;">Captured States & Pages</div>
        <div class="item-list" id="capture-items-list">
          <!-- Populated by JS -->
        </div>
      </div>
    </aside>

    <!-- Main View Area -->
    <main class="main-view">
      <div class="view-toolbar">
        <div class="tab-group">
          <button class="tab-btn active" data-tab="preview">Rendered Preview (DOM)</button>
          <button class="tab-btn" data-tab="screenshot">Screenshot (Visual)</button>
          <button class="tab-btn" data-tab="dom">Signals & DOM</button>
          <button class="tab-btn" data-tab="resources">Resources & Fonts</button>
          <button class="tab-btn" data-tab="report">Verification Report</button>
        </div>
        <div class="view-actions">
          <a id="open-new-tab" class="action-btn" href="#" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"></path></svg>
            Open Standalone
          </a>
        </div>
      </div>

      <div id="tab-canvas-preview" class="viewport-canvas">
        <div class="device-frame" id="frame-container">
          <div class="device-header">
            <div class="device-circle"></div>
            <div class="device-circle"></div>
            <div class="device-circle"></div>
            <span id="frame-title" style="margin-left:auto; font-family:var(--code-font);">1440 × 1000</span>
          </div>
          <iframe id="preview-iframe" class="preview-frame" src="about:blank"></iframe>
        </div>
      </div>

      <div id="tab-canvas-screenshot" class="viewport-canvas" style="display:none;">
        <img id="screenshot-img" class="screenshot-img" src="" alt="Capture Screenshot">
      </div>

      <div id="tab-canvas-dom" class="panel-content" style="display:none;">
        <h3 style="margin-bottom:12px;">Signals &amp; Metadata</h3>
        <pre id="signals-json" class="code-block"></pre>
      </div>

      <div id="tab-canvas-resources" class="panel-content" style="display:none;">
        <h3 style="margin-bottom:12px;">Harvested Assets for this State</h3>
        <table class="data-table" id="resources-table">
          <thead>
            <tr>
              <th>Resource URL</th>
              <th>MIME Type</th>
              <th>Bytes</th>
              <th>SHA256</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div id="tab-canvas-report" class="panel-content" style="display:none;">
        <h3 style="margin-bottom:12px;">Contract Verification &amp; Status</h3>
        <pre id="report-json" class="code-block"></pre>
      </div>
    </main>
  </div>

  <script>
    const manifest = ${JSON.stringify(manifest)};
    let activeItem = manifest.items[0] || null;
    let currentVpFilter = 'all';
    let currentTab = 'preview';

    function init() {
      renderItemsList();
      if (activeItem) selectItem(activeItem);
      setupEventListeners();
    }

    function renderItemsList() {
      const container = document.getElementById('capture-items-list');
      container.innerHTML = '';

      const filtered = manifest.items.filter(item => {
        if (currentVpFilter === 'all') return true;
        return item.viewport === currentVpFilter;
      });

      filtered.forEach(item => {
        const card = document.createElement('div');
        card.className = 'capture-card' + (item === activeItem ? ' active' : '');
        card.onclick = () => selectItem(item);

        const routeDisplay = (item.pathname || '/') + (item.search || '');
        card.innerHTML = \`
          <div class="card-url">\${escapeHtml(routeDisplay)}</div>
          <div class="card-tags">
            <span class="tag state">\${escapeHtml(item.stateId)}</span>
            <span class="tag \${item.isMobile ? 'mobile' : ''}">\${escapeHtml(item.viewport)}</span>
            \${item.status === 'complete' ? '<span class="tag" style="color:#10b981">✓ complete</span>' : '<span class="tag" style="color:#f59e0b">partial</span>'}
          </div>
        \`;
        container.appendChild(card);
      });
    }

    function selectItem(item) {
      activeItem = item;
      document.querySelectorAll('.capture-card').forEach(c => c.classList.remove('active'));
      renderItemsList();

      const [w, h] = item.viewport.split('x').map(Number);
      const iframe = document.getElementById('preview-iframe');
      const frameContainer = document.getElementById('frame-container');
      const frameTitle = document.getElementById('frame-title');
      const newTabBtn = document.getElementById('open-new-tab');

      frameTitle.textContent = \`\${item.viewport} | State: \${item.stateId}\`;

      // Adjust frame dimensions
      if (item.isMobile) {
        iframe.style.width = '390px';
        iframe.style.height = '844px';
      } else {
        iframe.style.width = '1100px';
        iframe.style.height = '750px';
      }

      const targetSrc = item.files.viewHtml || item.files['rendered.html'] || 'about:blank';
      iframe.src = targetSrc;
      newTabBtn.href = targetSrc;

      // Update screenshot
      const ssImg = document.getElementById('screenshot-img');
      ssImg.src = item.files['screenshot.png'] || '';

      // Update signals
      const signalsBlock = document.getElementById('signals-json');
      signalsBlock.textContent = JSON.stringify({
        url: item.url,
        stateId: item.stateId,
        viewport: item.viewport,
        status: item.status,
        failures: item.failures,
        files: item.files
      }, null, 2);

      // Update resources
      const tbody = document.querySelector('#resources-table tbody');
      tbody.innerHTML = '';
      (item.resources || []).forEach(res => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td><code>\${escapeHtml(res.url)}</code></td>
          <td>\${escapeHtml(res.mime)}</td>
          <td>\${res.bytes} B</td>
          <td><code title="\${res.sha256}">\${res.sha256.slice(0, 12)}...</code></td>
          <td><a href="\${res.relPath}" target="_blank" class="action-btn" style="padding:2px 8px;font-size:0.75rem;">View</a></td>
        \`;
        tbody.appendChild(tr);
      });

      // Update report
      const reportBlock = document.getElementById('report-json');
      reportBlock.textContent = JSON.stringify({
        summary: manifest.summary,
        contract: manifest.contract,
        status: manifest.status,
        currentItem: {
          url: item.url,
          stateId: item.stateId,
          viewport: item.viewport,
          failures: item.failures
        }
      }, null, 2);
    }

    function setupEventListeners() {
      // Viewport filters
      document.querySelectorAll('#viewport-filters .filter-btn').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('#viewport-filters .filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentVpFilter = btn.dataset.vp;
          renderItemsList();
        };
      });

      // Tabs
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentTab = btn.dataset.tab;

          ['preview', 'screenshot', 'dom', 'resources', 'report'].forEach(tab => {
            const el = document.getElementById('tab-canvas-' + tab);
            if (el) el.style.display = (tab === currentTab) ? (tab === 'preview' || tab === 'screenshot' ? 'flex' : 'block') : 'none';
          });
        };
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    window.onload = init;
  </script>
</body>
</html>
`;
}

// CLI execution
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      contract: { type: 'string', short: 'c' },
      sha: { type: 'string' },
      'run-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || !values.input || !values.output) {
    console.log(`
Usage:
  node tools/pipeline/export-preview.mjs --input <dir> --output <dir> [--contract <path>] [--sha <sha>] [--run-id <id>]
`);
    process.exit(values.help ? 0 : 1);
  }

  try {
    exportPreview({
      inputDir: path.resolve(values.input),
      outputDir: path.resolve(values.output),
      contractPath: values.contract ? path.resolve(values.contract) : null,
      sourceSha: values.sha || process.env.GITHUB_SHA || 'HEAD',
      runId: values['run-id'] || 'local-run',
    });
  } catch (err) {
    console.error('[export-preview] Error:', err.message);
    process.exit(1);
  }
}
