#!/usr/bin/env node
/**
 * Reference Pipeline – Evidence Adapter & Dynamic Entry Points Tests
 *
 * Direct verification suite covering:
 * 1. Raw DOM fidelity & non-hardcoding: unique text, class, attributes preserved; input mutation alters output
 * 2. Dynamic entry points table: derived from actual input DOM; updates dynamically; handles arbitrary counts
 * 3. Viewport isolation: desktop & mobile viewports yield distinct outputs without cross-viewport substitution
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptEvidence, extractDynamicEntryPoints } from '../../tools/pipeline/adapt-evidence.mjs';
import { exportPreview } from '../../tools/pipeline/export-preview.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORK_DIR = path.resolve(__dirname, '../../.replica/adapt-evidence-test-work');

function testWorkDir(name) {
  const dir = path.join(WORK_DIR, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('V1: Authentic DOM fidelity – Raw DOM text, node classes, and attributes are preserved in rendered.html; input mutation modifies output', () => {
  const workDir = testWorkDir('v1-dom-fidelity');
  const inputDir = path.join(workDir, 'input');
  const outputDir = path.join(workDir, 'output');
  fs.mkdirSync(inputDir, { recursive: true });

  const customSnippet = `<div class="reebelo-authentic-container custom-vendor-class-88" data-sku="TEST-SKU-VERBATIM-99">
    <h1 class="product-authentic-title">Authentic Special Edition Blue 512GB</h1>
    <span class="custom-badge-id" data-verified="true">100% Genuine Source DOM</span>
    <button id="e2e-pdp-bottom-bar-add-to-cart" class="vendor-button-buy">Add to Cart</button>
  </div>`;

  const pdpData = {
    title: 'Authentic Special Edition Blue 512GB',
    htmlSnippet: customSnippet,
  };
  fs.writeFileSync(path.join(inputDir, 'target-pdp-data.json'), JSON.stringify(pdpData, null, 2), 'utf8');

  // Run adaptation
  adaptEvidence({ inputDir, outputDir });

  const desktopRenderedPath = path.join(outputDir, 'pages', 'pdp-desktop', 'rendered.html');
  assert.ok(fs.existsSync(desktopRenderedPath), 'rendered.html must be generated');

  const renderedContent = fs.readFileSync(desktopRenderedPath, 'utf8');
  assert.ok(renderedContent.includes('reebelo-authentic-container custom-vendor-class-88'), 'Custom class must be preserved verbatim');
  assert.ok(renderedContent.includes('data-sku="TEST-SKU-VERBATIM-99"'), 'Custom attribute must be preserved verbatim');
  assert.ok(renderedContent.includes('Authentic Special Edition Blue 512GB'), 'Title text must be preserved verbatim');
  assert.ok(renderedContent.includes('100% Genuine Source DOM'), 'Span text must be preserved verbatim');
  assert.ok(!renderedContent.includes('415.30'), 'Must NOT generate fake hardcoded $415.30 price');

  // Mutation test: altering input alters output
  const mutatedSnippet = `<div class="reebelo-authentic-container mutated-class-777"><p>Altered Content String 99999</p></div>`;
  pdpData.title = 'Altered Title 99999';
  pdpData.htmlSnippet = mutatedSnippet;
  fs.writeFileSync(path.join(inputDir, 'target-pdp-data.json'), JSON.stringify(pdpData, null, 2), 'utf8');

  adaptEvidence({ inputDir, outputDir });
  const reRenderedContent = fs.readFileSync(desktopRenderedPath, 'utf8');
  assert.ok(reRenderedContent.includes('mutated-class-777'), 'Mutated class must appear in output');
  assert.ok(reRenderedContent.includes('Altered Content String 99999'), 'Mutated text must appear in output');
  assert.ok(!reRenderedContent.includes('Authentic Special Edition Blue 512GB'), 'Previous unmutated text must no longer be present');

  // Cleanup
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('V2: Dynamic entry points table – Entries are extracted directly from input DOM and update dynamically without hardcoded 13 items', () => {
  const workDir = testWorkDir('v2-entry-points');
  const inputDir = path.join(workDir, 'input');
  const outputDir = path.join(workDir, 'output');
  fs.mkdirSync(inputDir, { recursive: true });

  // DOM with exactly 3 links and 1 button (total 4 entries)
  const snippetWith4 = `<div>
    <a href="/collections/clearance">Flash Deals</a>
    <a href="https://trustpilot.com/review/reebelo">Trustpilot Reviews</a>
    <a href="#specifications">Tech Specs</a>
    <button id="trade-in-modal-btn" aria-label="Device trade-in calculator">Trade-in</button>
    <div class="sale-badge">Flash Sale (Div Only - Not A Link)</div>
  </div>`;

  const pdpData = {
    title: 'Dynamic Links Test PDP',
    htmlSnippet: snippetWith4,
  };
  fs.writeFileSync(path.join(inputDir, 'target-pdp-data.json'), JSON.stringify(pdpData, null, 2), 'utf8');

  adaptEvidence({ inputDir, outputDir });

  const entryPointsPath = path.join(outputDir, 'entry-points.json');
  assert.ok(fs.existsSync(entryPointsPath), 'entry-points.json must exist');

  const entryData = JSON.parse(fs.readFileSync(entryPointsPath, 'utf8'));
  assert.equal(entryData.total_entries, 4, 'Must extract exactly 4 entries from input DOM, NOT hardcoded 13');

  const clearanceLink = entryData.entries.find(e => e.label === 'Flash Deals');
  assert.ok(clearanceLink, 'Clearance link must be extracted');
  assert.equal(clearanceLink.target_url, 'https://reebelo.com/collections/clearance');
  assert.equal(clearanceLink.entry_type, 'Page navigation');

  const externalLink = entryData.entries.find(e => e.label === 'Trustpilot Reviews');
  assert.ok(externalLink, 'Trustpilot link must be extracted');
  assert.equal(externalLink.entry_type, 'External link');

  const tradeInBtn = entryData.entries.find(e => e.raw_action.includes('trade-in'));
  assert.ok(tradeInBtn, 'Trade-in button must be extracted');
  assert.equal(tradeInBtn.target_url, 'UNKNOWN', 'Button action must have UNKNOWN target_url, never guessed');

  // Verify div badge was NOT converted to a link
  assert.ok(!entryData.entries.some(e => e.target_url?.includes('/collections/flash-sale')), 'Div badge must not generate fake /collections/flash-sale link');

  // Mutation: remove one link from input DOM -> entry points table count must decrease
  const snippetWith3 = `<div>
    <a href="/collections/clearance">Flash Deals</a>
    <a href="#specifications">Tech Specs</a>
    <button id="trade-in-modal-btn">Trade-in</button>
  </div>`;
  pdpData.htmlSnippet = snippetWith3;
  fs.writeFileSync(path.join(inputDir, 'target-pdp-data.json'), JSON.stringify(pdpData, null, 2), 'utf8');

  adaptEvidence({ inputDir, outputDir });
  const updatedEntryData = JSON.parse(fs.readFileSync(entryPointsPath, 'utf8'));
  assert.equal(updatedEntryData.total_entries, 3, 'Must dynamically update to 3 entries after link removal');
  assert.ok(!updatedEntryData.entries.some(e => e.label === 'Trustpilot Reviews'), 'Removed link must not be in updated entries');

  // Cleanup
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('V3: Viewport isolation – Desktop and Mobile viewports produce distinct outputs without mutual substitution', () => {
  const workDir = testWorkDir('v3-viewport-isolation');
  const inputDir = path.join(workDir, 'input');
  const adaptedDir = path.join(workDir, 'adapted');
  const exportDir = path.join(workDir, 'export');
  fs.mkdirSync(inputDir, { recursive: true });

  const desktopSnippet = `<div class="desktop-only-grid"><h1>Desktop Header 1440</h1><div class="gallery-5-col">Desktop Gallery</div></div>`;
  const mobileBottomBar = {
    fixedBottomBars: [
      {
        tag: 'DIV',
        className: 'fixed bottom-0 z-[70] w-full bg-white lg:hidden',
        text: '$415.30 before trade-in Save $383.70 new $799.00 Add to Cart',
      },
    ],
  };

  fs.writeFileSync(path.join(inputDir, 'target-pdp-data.json'), JSON.stringify({
    title: 'iPhone 15',
    htmlSnippet: desktopSnippet,
  }, null, 2));

  fs.writeFileSync(path.join(inputDir, 'target-pdp-mobile-data.json'), JSON.stringify(mobileBottomBar, null, 2));

  // Dummy screenshots
  fs.writeFileSync(path.join(inputDir, 'target-pdp-desktop-1440.png'), 'desktop-png-bytes');
  fs.writeFileSync(path.join(inputDir, 'target-pdp-mobile-390.png'), 'mobile-png-bytes');

  // 1. Run adaptEvidence
  adaptEvidence({ inputDir, outputDir: adaptedDir });

  const desktopRendered = fs.readFileSync(path.join(adaptedDir, 'pages', 'pdp-desktop', 'rendered.html'), 'utf8');
  const mobileRendered = fs.readFileSync(path.join(adaptedDir, 'pages', 'pdp-mobile', 'rendered.html'), 'utf8');

  // Ensure desktop has desktop DOM
  assert.ok(desktopRendered.includes('desktop-only-grid'), 'Desktop must contain desktop DOM');
  assert.ok(!desktopRendered.includes('fixed bottom-0'), 'Desktop must NOT contain mobile bottom bar');

  // Ensure mobile has distinct mobile DOM and does NOT substitute desktop DOM
  assert.ok(mobileRendered.includes('fixed bottom-0'), 'Mobile must contain mobile bottom bar');
  assert.ok(!mobileRendered.includes('desktop-only-grid'), 'Mobile must NOT substitute desktop DOM');

  // 2. Run exportPreview
  const { previewManifest } = exportPreview({
    inputDir: adaptedDir,
    outputDir: exportDir,
  });

  assert.equal(previewManifest.items.length, 2, 'Export must have both desktop and mobile items');
  const desktopItem = previewManifest.items.find(i => i.viewport === '1440x1000');
  const mobileItem = previewManifest.items.find(i => i.viewport === '390x844');

  assert.ok(desktopItem, 'Desktop item must exist');
  assert.ok(mobileItem, 'Mobile item must exist');

  // Check distinct viewHtml paths
  assert.notEqual(desktopItem.files.viewHtml, mobileItem.files.viewHtml, 'Desktop and mobile must have distinct viewHtml paths');
  assert.ok(desktopItem.files.viewHtml.includes('pdp-desktop'), 'Desktop viewHtml path must be bound to pdp-desktop');
  assert.ok(mobileItem.files.viewHtml.includes('pdp-mobile'), 'Mobile viewHtml path must be bound to pdp-mobile');

  // Verify the static view files actually exist on disk and have distinct content
  const desktopViewFile = path.join(exportDir, desktopItem.files.viewHtml);
  const mobileViewFile = path.join(exportDir, mobileItem.files.viewHtml);

  assert.ok(fs.existsSync(desktopViewFile), 'Desktop static view file must exist');
  assert.ok(fs.existsSync(mobileViewFile), 'Mobile static view file must exist');

  const desktopViewContent = fs.readFileSync(desktopViewFile, 'utf8');
  const mobileViewContent = fs.readFileSync(mobileViewFile, 'utf8');

  assert.ok(desktopViewContent.includes('desktop-only-grid'), 'Desktop view must contain desktop grid');
  assert.ok(!desktopViewContent.includes('fixed bottom-0'), 'Desktop view must NOT contain mobile bottom bar');

  assert.ok(mobileViewContent.includes('fixed bottom-0'), 'Mobile view must contain mobile bottom bar');
  assert.ok(!mobileViewContent.includes('desktop-only-grid'), 'Mobile view must NOT contain desktop grid');

  // Cleanup
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('V4: Path safety – adaptEvidence rejects identical input/output dirs and parent deletion', () => {
  const workDir = testWorkDir('v4-safety');
  assert.throws(() => {
    adaptEvidence({ inputDir: workDir, outputDir: workDir });
  }, /Safety violation: inputDir and outputDir cannot be the same path/);

  const subDir = path.join(workDir, 'sub');
  fs.mkdirSync(subDir);
  assert.throws(() => {
    adaptEvidence({ inputDir: subDir, outputDir: workDir });
  }, /Safety violation: outputDir/);

  fs.rmSync(workDir, { recursive: true, force: true });
});
