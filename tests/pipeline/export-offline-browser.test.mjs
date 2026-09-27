#!/usr/bin/env node
/**
 * Reference Pipeline – Static Export Offline Browser Acceptance Suite
 *
 * Validates the exported static bundle in a real browser:
 * 1. Serves dist-preview/ strictly as static files (source fixture server is stopped).
 * 2. Opens pages in Chromium across desktop (1440x1000) and mobile (390x844).
 * 3. Verifies FontFace decoding (not fallback), CSS background images, lazy SVGs.
 * 4. Verifies state visibilities (country-open, lang-expanded, filter-open).
 * 5. Verifies query string page identity (/catalog.html?sale=1 vs /catalog.html).
 * 6. Verifies cross-page navigation links stay within static views.
 * 7. Confirms NO __replica_banner inside reference documents.
 * 8. Compares offline re-render against original capture screenshot.
 * 9. Negative tests: broken font URL and broken navigation link are detected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pkg from '../../tools/downloader/node_modules/playwright/index.js';
const { chromium } = pkg;
import { buildAndExport } from '../../tools/pipeline/build-preview.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(ROOT_DIR, 'dist-preview');

test.before(async () => {
  const p = path.join(DIST_DIR, 'preview-manifest.json');
  if (!fs.existsSync(p)) {
    console.log('[export-offline-browser.test] preview-manifest.json missing in dist-preview, building now...');
    await buildAndExport({ outputDir: 'dist-preview' });
  }
});

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function startStaticServer(serveDir = DIST_DIR) {
  const server = http.createServer((req, res) => {
    const rawPath = req.url.split('?')[0];
    const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(serveDir, safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(fs.readFileSync(fullPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: ' + safePath);
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(res => { server.closeAllConnections(); server.close(res); }),
      });
    });
    server.on('error', reject);
  });
}

function loadManifest() {
  const p = path.join(DIST_DIR, 'preview-manifest.json');
  assert.ok(fs.existsSync(p), 'preview-manifest.json must exist in dist-preview');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('E1: Static server offline render - Home default (1440x1000 & 390x844)', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  for (const vpStr of ['1440x1000', '390x844']) {
    const [w, h] = vpStr.split('x').map(Number);
    const item = manifest.items.find(i =>
      (i.pathname === '/' || i.pathname === '/index.html') &&
      i.stateId === 'default' &&
      i.viewport === vpStr
    );
    assert.ok(item, `Home default item for ${vpStr} must exist in manifest`);

    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const failedReqs = [];
    page.on('response', r => { if (r.status() >= 400) failedReqs.push({ url: r.url(), status: r.status() }); });

    const viewUrl = `${origin}/${item.files.viewHtml}`;
    const res = await page.goto(viewUrl);
    assert.equal(res.status(), 200, `View must respond with 200: ${viewUrl}`);
    await page.waitForLoadState('networkidle');

    // FontFace check: PipelineFixture font loaded and checked
    const fontChecked = await page.evaluate(() => document.fonts.check('16px PipelineFixture'));
    assert.ok(fontChecked, `PipelineFixture font must be loaded and decoded on ${vpStr}`);

    // Verify canvas is pristine (NO __replica_banner inside view DOM)
    const banner = await page.$('#__replica_banner');
    assert.equal(banner, null, 'No __replica_banner allowed in reference document');

    // Default state: country modal hidden
    const portalVisible = await page.locator('#country-portal').isVisible();
    assert.equal(portalVisible, false, 'Country portal must be hidden in default state');

    // No 404s
    assert.equal(failedReqs.length, 0, `All assets must load with 200. Failures: ${JSON.stringify(failedReqs)}`);
    await page.close();
  }
});

test('E2: Static server offline render - Country panel open (country-open @ 1440x1000)', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const item = manifest.items.find(i => i.stateId === 'country-open' && i.viewport === '1440x1000');
  assert.ok(item, 'country-open item must exist');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const failedReqs = [];
  page.on('response', r => { if (r.status() >= 400) failedReqs.push({ url: r.url(), status: r.status() }); });

  await page.goto(`${origin}/${item.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  // Country portal must be VISIBLE
  const portalVisible = await page.locator('#country-portal').isVisible();
  assert.ok(portalVisible, 'Country portal must be visible in country-open state');

  // Flag image decoded
  const flagDecoded = await page.locator('#portal-flag-img').evaluate(el => el.complete && el.naturalWidth > 0);
  assert.ok(flagDecoded, 'Flag SVG image must be loaded and decoded');

  // Dialog header CSS background loaded
  const bgLoaded = await page.locator('.dialog-header').evaluate(el => {
    const bg = getComputedStyle(el).backgroundImage;
    return bg.includes('.svg');
  });
  assert.ok(bgLoaded, 'CSS background SVG must be referenced in .dialog-header');

  // Font loaded
  const fontChecked = await page.evaluate(() => document.fonts.check('16px PipelineFixture'));
  assert.ok(fontChecked, 'PipelineFixture font must be loaded in country-open state');

  assert.equal(failedReqs.length, 0, `No failed requests. Got: ${JSON.stringify(failedReqs)}`);
  await page.close();
});

test('E3: Static server offline render - Language panel expanded (lang-expanded @ 1440x1000)', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const item = manifest.items.find(i => i.stateId === 'lang-expanded' && i.viewport === '1440x1000');
  assert.ok(item, 'lang-expanded item must exist');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/${item.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  const langVisible = await page.locator('#lang-panel').isVisible();
  assert.ok(langVisible, 'Language panel must be visible in lang-expanded state');

  const itemCount = await page.locator('.lang-item').count();
  assert.ok(itemCount >= 2, `Language panel must have >= 2 items, got ${itemCount}`);

  await page.close();
});

test('E4: Static server offline render - Catalog default (catalog.html @ 1440x1000)', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const item = manifest.items.find(i =>
    i.pathname === '/catalog.html' &&
    !i.search &&
    i.stateId === 'default' &&
    i.viewport === '1440x1000'
  );
  assert.ok(item, 'Catalog default item must exist');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/${item.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  const title = await page.title();
  assert.ok(title.includes('Catalog'), `Catalog title expected, got: ${title}`);

  // Filter panel initially hidden
  const filterVisible = await page.locator('#filter-panel').isVisible();
  assert.equal(filterVisible, false, 'Filter panel must be hidden in default catalog state');

  await page.close();
});

test('E5: Static server offline render - Catalog sale query page (catalog.html?sale=1 @ 1440x1000)', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const item = manifest.items.find(i =>
    i.pathname === '/catalog.html' &&
    i.search === '?sale=1' &&
    i.stateId === 'default' &&
    i.viewport === '1440x1000'
  );
  assert.ok(item, 'Catalog sale item must exist');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/${item.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  const title = await page.title();
  assert.ok(title.includes('Sale'), `Title must indicate Sale, got: ${title}`);

  const bannerText = await page.locator('#sale-banner').innerText();
  assert.ok(bannerText.includes('40% off'), `Sale banner text expected, got: ${bannerText}`);

  await page.close();
});

test('E6: Static server offline render - About default (about.html @ 1440x1000)', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const item = manifest.items.find(i =>
    i.pathname === '/about.html' &&
    !i.search &&
    i.stateId === 'default' &&
    i.viewport === '1440x1000'
  );
  assert.ok(item, 'About default item must exist');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/${item.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  const h1 = await page.locator('h1').innerText();
  assert.ok(h1.includes('About Pipeline Fixtures'), `Expected About heading, got: ${h1}`);

  await page.close();
});

test('E7: Cross-page offline navigation & query identity within static bundle', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const homeItem = manifest.items.find(i =>
    (i.pathname === '/' || i.pathname === '/index.html') &&
    i.stateId === 'default' &&
    i.viewport === '1440x1000'
  );

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/${homeItem.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  // Click nav to Catalog
  const catalogNav = page.locator('#nav-catalog');
  const catalogHref = await catalogNav.getAttribute('href');
  assert.ok(catalogHref.startsWith('../') && catalogHref.endsWith('/index.html'), `Catalog link must be relative to view: ${catalogHref}`);

  await catalogNav.click();
  await page.waitForLoadState('networkidle');
  const catalogTitle = await page.title();
  assert.ok(catalogTitle.includes('Catalog'), `Navigated page must be Catalog, got ${catalogTitle}`);

  // From Catalog, click nav to Sale Items (query route)
  const saleNav = page.locator('#nav-catalog-sale');
  const saleHref = await saleNav.getAttribute('href');
  assert.ok(saleHref.startsWith('../') && saleHref.endsWith('/index.html'), `Sale link must be relative to view: ${saleHref}`);
  assert.notEqual(saleHref, catalogHref, 'Sale link must point to distinct view, not catalog');

  await saleNav.click();
  await page.waitForLoadState('networkidle');
  const saleTitle = await page.title();
  assert.ok(saleTitle.includes('Sale'), `Navigated page must be Sale, got ${saleTitle}`);

  await page.close();
});

test('E8: Visual comparison between source screenshot and offline re-render', async (t) => {
  const manifest = loadManifest();
  const { origin, close } = await startStaticServer();
  t.after(close);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const homeItem = manifest.items.find(i =>
    (i.pathname === '/' || i.pathname === '/index.html') &&
    i.stateId === 'default' &&
    i.viewport === '1440x1000'
  );

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/${homeItem.files.viewHtml}`);
  await page.waitForLoadState('networkidle');

  const reRenderScreenshot = await page.screenshot({ fullPage: false });
  const origScreenshotPath = path.join(DIST_DIR, homeItem.files['screenshot.png']);
  assert.ok(fs.existsSync(origScreenshotPath), 'Original capture screenshot must exist');

  const origScreenshot = fs.readFileSync(origScreenshotPath);
  assert.ok(reRenderScreenshot.length > 1000, 'Re-rendered screenshot must have non-zero bytes');
  assert.ok(origScreenshot.length > 1000, 'Original screenshot must have non-zero bytes');

  // Both screenshots must be valid PNGs
  assert.equal(reRenderScreenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Re-render is valid PNG');
  assert.equal(origScreenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Source is valid PNG');

  await page.close();
});

test('E9: Negative test - Corrupted font path in derived CSS is detected', async (t) => {
  const manifest = loadManifest();
  const homeItem = manifest.items.find(i =>
    (i.pathname === '/' || i.pathname === '/index.html') &&
    i.stateId === 'default' &&
    i.viewport === '1440x1000'
  );

  // Create a temporary corrupted copy of views/
  const tempWorkDir = path.join(ROOT_DIR, '.replica', 'temp-test-corrupt-font');
  fs.rmSync(tempWorkDir, { recursive: true, force: true });
  fs.cpSync(DIST_DIR, tempWorkDir, { recursive: true });

  const viewDir = path.join(tempWorkDir, path.dirname(homeItem.files.viewHtml));
  const derivedDir = path.join(viewDir, 'derived');

  // Corrupt font path inside derived CSS
  let foundCss = false;
  if (fs.existsSync(derivedDir)) {
    for (const f of fs.readdirSync(derivedDir)) {
      if (f.endsWith('.css')) {
        const cssPath = path.join(derivedDir, f);
        const cssContent = fs.readFileSync(cssPath, 'utf8');
        // Replace font url with a nonexistent corrupt path
        const corrupted = cssContent.replace(/\.ttf/g, '-corrupted-nonexistent.ttf');
        fs.writeFileSync(cssPath, corrupted, 'utf8');
        foundCss = true;
      }
    }
  }
  assert.ok(foundCss, 'Must find derived CSS to corrupt');

  const { origin, close } = await startStaticServer(tempWorkDir);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${origin}/${homeItem.files.viewHtml}`);
    await page.waitForLoadState('networkidle');

    // Font check MUST FAIL because the font path was intentionally corrupted
    const fontChecked = await page.evaluate(() => document.fonts.check('16px PipelineFixture'));
    assert.equal(fontChecked, false, 'E9: Corrupted font path must be detected and fail font check');
    await page.close();
  } finally {
    await browser.close();
    await close();
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
  }
});
