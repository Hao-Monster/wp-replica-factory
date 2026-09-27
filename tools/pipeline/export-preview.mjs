#!/usr/bin/env node
/**
 * Reference Pipeline – Static Preview Exporter
 *
 * Generates a self-contained, sanitized, offline-viewable static site
 * from a reference pipeline capture run.
 *
 * Output is suitable for direct deployment to GitHub Pages or local static serving.
 *
 * Guarantees:
 * - Subpath-friendly: works at /wp-replica-factory/ or local static server
 * - Preserves original raw DOM & files in captures/ while creating localized views in views/
 * - Derivative HTML & CSS are localized using parse5, postcss, and srcset (no string replacement guessing)
 * - Reference canvas is pristine (NO injected __replica_banner inside reference views)
 * - Iframe dimensions faithfully match captured viewports (1440x1000 desktop, 390x844 mobile)
 * - Cross-page navigation maps to saved static views (preserving query parameters and viewport context)
 * - Uncaptured links show clear gap indications instead of jumping to domain root
 * - Scripts in static views are neutralized (type="text/plain") to prevent re-execution resetting state
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { parse, serialize } = require('../downloader/node_modules/parse5');
const postcss = require('../downloader/node_modules/postcss');
const safeParser = require('../downloader/node_modules/postcss-safe-parser');
const valueParser = require('../downloader/node_modules/postcss-value-parser');
const { parseSrcset, stringifySrcset } = require('../downloader/node_modules/srcset');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

function normalizeRoutePath(rawUrl) {
  try {
    const u = new URL(rawUrl, 'http://127.0.0.1');
    let pathname = u.pathname;
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    return pathname + (u.search || '');
  } catch {
    return rawUrl;
  }
}

export function exportPreview({ inputDir, outputDir, contractPath, sourceSha, runId }) {
  console.log(`[export-preview] Reading pipeline output from: ${inputDir}`);
  console.log(`[export-preview] Target export directory: ${outputDir}`);

  if (!fs.existsSync(inputDir)) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  // 1. Locate reference-index.json
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

  // 3. First pass: build global navigation lookup map across all captures
  // Maps routePath@viewport -> captureId (default state)
  const navigationMap = new Map();
  const allCaptures = [];

  for (const [key, entry] of Object.entries(refIndex.pages || {})) {
    const { url, stateId, viewport, captureDir, files = {} } = entry;
    const absCaptureDir = path.isAbsolute(captureDir) ? captureDir : path.resolve(actualInputDir, captureDir);
    const captureId = path.basename(absCaptureDir);

    if (!fs.existsSync(absCaptureDir)) {
      console.warn(`[export-preview] Warning: captureDir does not exist: ${absCaptureDir}`);
      continue;
    }

    allCaptures.push({
      key,
      entry,
      captureId,
      absCaptureDir,
      url,
      stateId,
      viewport,
      files,
    });

    const routePath = normalizeRoutePath(url);
    if (stateId === 'default') {
      navigationMap.set(`${routePath}@${viewport}`, captureId);
      // Also map / to /index.html and vice versa
      if (routePath.startsWith('/index.html')) {
        const rootRoute = '/' + routePath.slice('/index.html'.length);
        navigationMap.set(`${rootRoute}@${viewport}`, captureId);
      } else if (routePath === '/') {
        navigationMap.set(`/index.html@${viewport}`, captureId);
      }
    }
    navigationMap.set(`${routePath}@${stateId}@${viewport}`, captureId);
  }

  // 4. Second pass: copy raw captures and generate derivative offline views
  const items = [];
  const allResources = new Map();

  for (const cap of allCaptures) {
    const { captureId, absCaptureDir, url, stateId, viewport, files } = cap;
    const destCaptureDir = path.join(exportCapturesDir, captureId);
    fs.mkdirSync(destCaptureDir, { recursive: true });

    // Copy manifest (sanitized)
    const manifestPath = path.join(absCaptureDir, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    if (manifest) {
      const sanitizedManifest = { ...manifest };
      if (sanitizedManifest.policy) {
        delete sanitizedManifest.policy.storageDir;
      }
      fs.writeFileSync(path.join(destCaptureDir, 'manifest.json'), JSON.stringify(sanitizedManifest, null, 2));
    }

    // Copy all pages/ subdirectories so all state captures are available
    const srcPagesDir = path.join(absCaptureDir, 'pages');
    const destPagesDir = path.join(destCaptureDir, 'pages');
    if (fs.existsSync(srcPagesDir)) {
      fs.cpSync(srcPagesDir, destPagesDir, { recursive: true });
    }

    // Match exact state capture in manifest.captures
    const capMatch = manifest?.captures?.find(c =>
      (c.state === stateId || (!c.state && stateId === 'default')) &&
      (!viewport || `${c.viewport?.width}x${c.viewport?.height}` === viewport)
    ) || manifest?.captures?.find(c => c.state === stateId) || manifest?.captures?.[0];

    // Copy raw page files (rendered.html, screenshot.png, signals.json, routes.json, reports/)
    const exportFiles = {};
    for (const [fileKey, relPath] of Object.entries(files)) {
      const actualRelPath = capMatch?.files?.[fileKey]?.path || relPath;
      const srcFile = path.join(absCaptureDir, actualRelPath);
      if (fs.existsSync(srcFile)) {
        const destFile = path.join(destCaptureDir, actualRelPath);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(srcFile, destFile);
        exportFiles[fileKey] = `captures/${captureId}/${actualRelPath.replace(/\\/g, '/')}`;
      }
    }

    for (const extra of ['routes.json', 'resources.json', 'reports/download.json']) {
      const srcExtra = path.join(absCaptureDir, extra);
      if (fs.existsSync(srcExtra)) {
        const destExtra = path.join(destCaptureDir, extra);
        fs.mkdirSync(path.dirname(destExtra), { recursive: true });
        fs.copyFileSync(srcExtra, destExtra);
      }
    }

    // Copy original site/objects (untouched)
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

    // Build resource map for this capture
    const resourcesPath = path.join(absCaptureDir, 'resources.json');
    const resourcesData = fs.existsSync(resourcesPath) ? JSON.parse(fs.readFileSync(resourcesPath, 'utf8')) : null;
    const captureResources = [];
    const byUrl = new Map();

    for (const r of (resourcesData?.resources || [])) {
      if (r.status === 'saved' && r.local_path) {
        const objName = path.basename(r.local_path);
        const assetRelPath = `captures/${captureId}/site/objects/${objName}`;
        const resInfo = {
          url: r.url,
          response_url: r.response_url || r.url,
          mime: r.mime,
          bytes: r.bytes,
          sha256: r.raw_sha256,
          relPath: assetRelPath,
          objName,
        };
        captureResources.push(resInfo);
        allResources.set(r.url, resInfo);

        // Populate lookup keys
        byUrl.set(r.url, resInfo);
        byUrl.set(r.response_url || r.url, resInfo);
        try {
          const u = new URL(r.url);
          byUrl.set(u.pathname, resInfo);
          byUrl.set(u.pathname + (u.search || ''), resInfo);
        } catch { /* ignore */ }
        byUrl.set(objName, resInfo);
        byUrl.set(`/objects/${objName}`, resInfo);
        byUrl.set(`objects/${objName}`, resInfo);
      }
    }

    // 5. Generate derivative localized view in views/<captureId>/
    const destViewDir = path.join(exportViewsDir, captureId);
    const derivedAssetsDir = path.join(destViewDir, 'derived');
    fs.mkdirSync(derivedAssetsDir, { recursive: true });

    // Localization helper for CSS
    const rewriteCssContent = (cssText, cssBaseUrl) => {
      let ast;
      try {
        ast = postcss.parse(cssText, { from: undefined });
      } catch {
        ast = safeParser(cssText, { from: undefined });
      }

      const rewriteValue = (valText) => {
        const parsed = valueParser(valText);
        parsed.walk(node => {
          if (node.type === 'function' && node.value.toLowerCase() === 'url') {
            const raw = valueParser.stringify(node.nodes).trim().replace(/^(['"])(.*)\1$/s, '$2');
            if (raw && !raw.startsWith('data:') && !raw.startsWith('#')) {
              let targetObjName = null;
              // Check /objects/ prefix first
              if (raw.includes('objects/')) {
                const basename = path.basename(raw);
                if (byUrl.has(basename)) targetObjName = byUrl.get(basename).objName;
              }
              if (!targetObjName) {
                try {
                  const abs = new URL(raw, cssBaseUrl).href;
                  if (byUrl.has(abs)) targetObjName = byUrl.get(abs).objName;
                  else {
                    const pathname = new URL(abs).pathname;
                    if (byUrl.has(pathname)) targetObjName = byUrl.get(pathname).objName;
                  }
                } catch { /* ignore */ }
              }

              if (targetObjName) {
                // Derived CSS is in views/<captureId>/derived/<cssName> (3 levels deep from export root)
                // Path to asset: ../../../captures/<captureId>/site/objects/<targetObjName>
                const relativeToCss = `../../../captures/${captureId}/site/objects/${targetObjName}`;
                node.nodes = [{ type: 'string', quote: '"', value: relativeToCss }];
              }
            }
            return false;
          }
        });
        return parsed.toString();
      };

      ast.walkDecls(decl => {
        decl.value = rewriteValue(decl.value);
      });
      ast.walkAtRules('import', rule => {
        rule.params = rewriteValue(rule.params);
      });
      return ast.toString();
    };

    // Pre-localize all CSS resources into views/<captureId>/derived/
    const localizedCssMap = new Map();
    for (const res of captureResources) {
      if (res.mime.includes('text/css')) {
        const origCssPath = path.join(destObjectsDir, res.objName);
        if (fs.existsSync(origCssPath)) {
          const rawCss = fs.readFileSync(origCssPath, 'utf8');
          const localizedCss = rewriteCssContent(rawCss, res.response_url);
          const derivedCssFile = path.join(derivedAssetsDir, res.objName);
          fs.writeFileSync(derivedCssFile, localizedCss, 'utf8');
          localizedCssMap.set(res.url, `./derived/${res.objName}`);
          localizedCssMap.set(res.objName, `./derived/${res.objName}`);
        }
      }
    }

    // Now localize HTML
    let viewRelPath = null;
    const actualRenderedRel = capMatch?.files?.['rendered.html']?.path || files['rendered.html'];
    const rawRenderedPath = actualRenderedRel ? path.join(absCaptureDir, actualRenderedRel) : null;
    if (rawRenderedPath && fs.existsSync(rawRenderedPath)) {
      const rawHtml = fs.readFileSync(rawRenderedPath, 'utf8');
      const ast = parse(rawHtml);
      let documentBase = url;

      // Scan and remove any existing <base> tag to prevent relative hijacking
      function inspectBase(node) {
        if (node.tagName === 'base') {
          const hrefAttr = node.attrs?.find(a => a.name === 'href')?.value;
          if (hrefAttr) {
            try { documentBase = new URL(hrefAttr, documentBase).href; } catch { /* ignore */ }
          }
        }
        for (const child of (node.childNodes || [])) inspectBase(child);
      }
      inspectBase(ast);

      // Walk and rewrite nodes
      function walkNode(node) {
        // Filter out unwanted tags (<base>, injected banners, CSP)
        if (node.childNodes) {
          node.childNodes = node.childNodes.filter(c => {
            if (c.tagName === 'base') return false;
            if (c.attrs?.some(a => a.name === 'id' && a.value === '__replica_banner')) return false;
            if (c.tagName === 'meta' && c.attrs?.some(a => a.name === 'http-equiv' && ['refresh', 'content-security-policy'].includes(a.value.toLowerCase()))) return false;
            return true;
          });
        }

        // Script neutralization for static views:
        // Prevent scripts from executing on load and resetting captured interactive panels (e.g. country selector)
        if (node.tagName === 'script') {
          const srcAttr = node.attrs?.find(a => a.name === 'src');
          if (srcAttr) {
            const rawSrc = srcAttr.value;
            let targetObj = null;
            try {
              const abs = new URL(rawSrc, documentBase).href;
              if (byUrl.has(abs)) targetObj = byUrl.get(abs).objName;
            } catch { /* ignore */ }
            node.attrs = node.attrs.filter(a => a.name !== 'src' && a.name !== 'type');
            node.attrs.push({ name: 'type', value: 'text/plain' });
            node.attrs.push({ name: 'data-preserved-script', value: 'true' });
            if (targetObj) {
              node.attrs.push({ name: 'data-preserved-src', value: `../../captures/${captureId}/site/objects/${targetObj}` });
            }
            node.attrs.push({ name: 'data-original-src', value: rawSrc });
          } else {
            node.attrs = (node.attrs || []).filter(a => a.name !== 'type');
            node.attrs.push({ name: 'type', value: 'text/plain' });
            node.attrs.push({ name: 'data-preserved-inline', value: 'true' });
          }
        }

        if (node.attrs) {
          // Remove integrity/crossorigin attributes that would fail on local/derived files
          node.attrs = node.attrs.filter(a => !['integrity', 'crossorigin', 'ping'].includes(a.name));

          for (const attr of node.attrs) {
            const name = attr.name;
            const val = attr.value;
            if (!val || val.startsWith('data:') || val.startsWith('#')) continue;

            // 1. Stylesheets
            if (node.tagName === 'link' && node.attrs.some(a => a.name === 'rel' && a.value === 'stylesheet') && name === 'href') {
              let matchedCss = null;
              if (val.includes('objects/')) {
                const bname = path.basename(val);
                if (localizedCssMap.has(bname)) matchedCss = localizedCssMap.get(bname);
              }
              if (!matchedCss) {
                try {
                  const abs = new URL(val, documentBase).href;
                  if (localizedCssMap.has(abs)) matchedCss = localizedCssMap.get(abs);
                  else {
                    const p = new URL(abs).pathname;
                    if (byUrl.has(p)) matchedCss = `./derived/${byUrl.get(p).objName}`;
                  }
                } catch { /* ignore */ }
              }
              if (matchedCss) {
                attr.value = matchedCss;
                continue;
              }
            }

            // 2. Preload / Images / Icons
            if (['src', 'poster', 'href'].includes(name) && node.tagName !== 'a') {
              let targetObj = null;
              if (val.includes('objects/')) {
                const bname = path.basename(val);
                if (byUrl.has(bname)) targetObj = byUrl.get(bname).objName;
              }
              if (!targetObj) {
                try {
                  const abs = new URL(val, documentBase).href;
                  if (byUrl.has(abs)) targetObj = byUrl.get(abs).objName;
                  else {
                    const p = new URL(abs).pathname;
                    if (byUrl.has(p)) targetObj = byUrl.get(p).objName;
                  }
                } catch { /* ignore */ }
              }
              if (targetObj) {
                attr.value = `../../captures/${captureId}/site/objects/${targetObj}`;
                continue;
              }
            }

            // 3. Lazy images (data-src)
            if (name === 'data-src') {
              try {
                const abs = new URL(val, documentBase).href;
                if (byUrl.has(abs)) {
                  attr.value = `../../captures/${captureId}/site/objects/${byUrl.get(abs).objName}`;
                  continue;
                }
              } catch { /* ignore */ }
            }

            // 4. srcset
            if (name === 'srcset') {
              try {
                const candidates = parseSrcset(val);
                for (const item of candidates) {
                  const abs = new URL(item.url, documentBase).href;
                  if (byUrl.has(abs)) {
                    item.url = `../../captures/${captureId}/site/objects/${byUrl.get(abs).objName}`;
                  }
                }
                attr.value = stringifySrcset(candidates);
                continue;
              } catch { /* ignore */ }
            }

            // 5. Inline style attribute
            if (name === 'style') {
              attr.value = rewriteCssContent(val, documentBase);
              continue;
            }

            // 6. Navigation links: <a href="...">
            if (node.tagName === 'a' && name === 'href') {
              try {
                const u = new URL(val, documentBase);
                const pageOrigin = new URL(url).origin;
                if (u.origin === pageOrigin) {
                  // Internal link: find matching captured view for the SAME viewport
                  const routePath = normalizeRoutePath(u.href);
                  let targetCapId = navigationMap.get(`${routePath}@${viewport}`);
                  if (!targetCapId && routePath === '/') targetCapId = navigationMap.get(`/index.html@${viewport}`);
                  if (!targetCapId && routePath.startsWith('/index.html')) targetCapId = navigationMap.get(`/@${viewport}`);

                  if (targetCapId) {
                    const fragment = u.hash || '';
                    attr.value = `../${targetCapId}/index.html${fragment}`;
                  } else {
                    // Mark uncaptured internal page gap clearly
                    attr.value = '#uncaptured-gap';
                    node.attrs.push({ name: 'data-gap-url', value: routePath });
                    node.attrs.push({ name: 'title', value: `Uncaptured reference gap: ${routePath}` });
                  }
                  continue;
                }
              } catch { /* ignore */ }
            }
          }
        }

        // Inline <style> tags
        if (node.tagName === 'style') {
          for (const child of (node.childNodes || [])) {
            if (child.nodeName === '#text') {
              child.value = rewriteCssContent(child.value, documentBase);
            }
          }
        }

        for (const child of (node.childNodes || [])) walkNode(child);
        if (node.content) walkNode(node.content);
      }

      walkNode(ast);
      const finalHtml = serialize(ast);
      const viewHtmlFile = path.join(destViewDir, 'index.html');
      fs.writeFileSync(viewHtmlFile, finalHtml, 'utf8');
      viewRelPath = `views/${captureId}/index.html`;

      // Record derivative summary
      fs.writeFileSync(path.join(destViewDir, 'derived.json'), JSON.stringify({
        captureId,
        url,
        stateId,
        viewport,
        originalRenderedHtml: files['rendered.html'] || null,
        derivedViewHtml: viewRelPath,
        localizedCssCount: localizedCssMap.size,
        generatedAt: new Date().toISOString(),
      }, null, 2));
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

  // 6. Compute overall metadata
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

  // 7. Generate index.html Portal UI
  const portalHtml = generatePortalHtml(previewManifest);
  fs.writeFileSync(path.join(outputDir, 'index.html'), portalHtml, 'utf8');

  // 8. Security audit
  auditExport(outputDir);

  console.log(`[export-preview] Successfully exported ${totalCaptures} capture items to ${outputDir}`);
  return { previewManifest, outputDir };
}

function auditExport(dir) {
  const sensitivePatterns = [
    /\.env/i,
    /cookie/i,
    /token/i,
    /\.git\b/i,
    /id_rsa/i,
    /users\\.*?\\/i,
  ];

  function walk(current) {
    for (const f of fs.readdirSync(current)) {
      const full = path.join(current, f);
      for (const pattern of sensitivePatterns) {
        if (pattern.test(full)) {
          throw new Error(`[export-preview] Security violation: export directory contains sensitive file/pattern: ${full}`);
        }
      }
      if (fs.statSync(full).isDirectory()) walk(full);
    }
  }
  walk(dir);
}

function generatePortalHtml(manifest) {
  const { sourceSha, runId, generatedAt, status, summary, items } = manifest;
  const statusColor = status === 'REFERENCE_READY' ? '#10b981' : (status === 'TECH_VERIFIED' ? '#38bdf8' : '#f59e0b');
  const statusBadge = status || 'UNKNOWN';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reference Pipeline Preview – Hao-Monster/wp-replica-factory</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --code-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--card-border);
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }
    .brand-title {
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #fff;
    }
    .badge {
      font-size: 0.75rem;
      padding: 3px 8px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-status {
      background: ${statusColor}22;
      color: ${statusColor};
      border: 1px solid ${statusColor}44;
    }
    .meta-bar {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .meta-item code {
      color: #e2e8f0;
      background: #1e293b;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--code-font);
    }
    .notice-bar {
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
      padding: 6px 20px;
      font-size: 0.75rem;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .layout-container {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .sidebar {
      width: 320px;
      background: #0d1322;
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .sidebar-section {
      padding: 14px 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .sidebar-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
      font-weight: 600;
    }
    .filter-group {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .filter-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #94a3b8;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-btn:hover { background: #334155; color: #fff; }
    .filter-btn.active {
      background: var(--accent);
      color: #0b0f19;
      border-color: var(--accent);
      font-weight: 600;
    }
    .item-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .capture-card {
      background: #151d2f;
      border: 1px solid #222f46;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .capture-card:hover {
      border-color: #38bdf888;
      background: #1a243a;
    }
    .capture-card.active {
      border-color: var(--accent);
      background: #192742;
      box-shadow: 0 0 0 1px var(--accent);
    }
    .card-url {
      font-family: var(--code-font);
      font-size: 0.8rem;
      color: #e2e8f0;
      word-break: break-all;
      margin-bottom: 4px;
    }
    .card-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
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
      flex-wrap: wrap;
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
    .zoom-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .zoom-btn.active {
      background: var(--accent);
      color: #0b0f19;
      font-weight: 600;
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
      transition: width 0.2s ease, height 0.2s ease, transform 0.2s ease;
      transform-origin: top center;
    }
    .device-header {
      background: #1e293b;
      padding: 6px 14px;
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
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
      </svg>
      wp-replica-factory
      <span class="badge badge-status">${statusBadge}</span>
    </div>
    <div class="meta-bar">
      <div class="meta-item">SHA: <code>${escapeHtml(sourceSha.slice(0, 10))}</code></div>
      <div class="meta-item">Run: <code>${escapeHtml(String(runId).slice(0, 10))}</code></div>
      <div class="meta-item">Pages: <code>${summary.pageCount}</code></div>
      <div class="meta-item">States: <code>${summary.stateCount}</code></div>
      <div class="meta-item">Viewports: <code>${summary.viewportCount}</code></div>
      <div class="meta-item">Resources: <code>${summary.resourceCount}</code></div>
    </div>
  </header>

  <div class="notice-bar">
    <div>
      <strong>Mode:</strong> Owned-Fixture Reference Pipeline MVP &bull; Pristine Reference Canvas (No Injected Banner) &bull; Accurate Viewport (1440x1000 / 390x844) &bull; Offline FontFace Verified
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
        <div class="item-list" id="capture-items-list"></div>
      </div>
    </aside>

    <!-- Main View Area -->
    <main class="main-view">
      <div class="view-toolbar">
        <div class="tab-group">
          <button class="tab-btn active" data-tab="preview">Rendered Preview (DOM)</button>
          <button class="tab-btn" data-tab="screenshot">Screenshot (Visual)</button>
          <button class="tab-btn" data-tab="dom">Signals & DOM</button>
          <button class="tab-btn" data-tab="resources">Resources & Assets</button>
          <button class="tab-btn" data-tab="report">Verification Report</button>
        </div>
        <div class="view-actions">
          <span style="font-size:0.75rem; color:var(--text-muted); margin-right:4px;">Zoom:</span>
          <button class="zoom-btn active" data-zoom="1">100%</button>
          <button class="zoom-btn" data-zoom="0.75">75%</button>
          <button class="zoom-btn" data-zoom="0.5">50%</button>
          <button class="zoom-btn" data-zoom="fit">Fit</button>
          <a id="open-new-tab" class="action-btn" href="#" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"></path></svg>
            Open Standalone View
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
          <iframe id="preview-iframe" class="preview-frame" sandbox="allow-same-origin" src="about:blank"></iframe>
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
    let currentZoom = '1';

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

    function applyZoom() {
      const frameContainer = document.getElementById('frame-container');
      const canvas = document.getElementById('tab-canvas-preview');
      if (!activeItem) return;

      const [w, h] = activeItem.viewport.split('x').map(Number);
      if (currentZoom === 'fit') {
        const availableW = canvas.clientWidth - 48;
        const availableH = canvas.clientHeight - 80;
        const scale = Math.min(availableW / w, availableH / (h + 32), 1);
        frameContainer.style.transform = \`scale(\${scale})\`;
      } else {
        const scale = parseFloat(currentZoom) || 1;
        frameContainer.style.transform = scale === 1 ? 'none' : \`scale(\${scale})\`;
      }
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

      // Set actual captured dimensions on iframe
      iframe.style.width = w + 'px';
      iframe.style.height = h + 'px';
      frameContainer.style.width = w + 'px';
      applyZoom();

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
          <td><a href="\${res.relPath}" target="_blank" class="action-btn" style="padding:2px 8px;font-size:0.75rem;">View Raw</a></td>
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

      // Zoom buttons
      document.querySelectorAll('.zoom-btn').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentZoom = btn.dataset.zoom;
          applyZoom();
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

      window.onresize = () => {
        if (currentZoom === 'fit') applyZoom();
      };
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
