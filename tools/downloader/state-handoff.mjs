import fs from 'node:fs';
import path from 'node:path';
import valueParser from 'postcss-value-parser';
import { parseSrcset } from 'srcset';
import { sha, safeFile, readJSON, json, put } from './core.mjs';

const ALLOWED_STATE_FIELDS = new Set([
  'name', 'state_id', 'path', 'preconditions', 'actions',
  'assertions', 'restores_state', 'required_resources',
  'component_selector', 'portal_selector', 'expected_route'
]);

const ALLOWED_ACTION_TYPES = new Set(['click', 'hover', 'scroll']);
const ALLOWED_ACTION_FIELDS = new Set(['type', 'selector', 'y']);
const ALLOWED_ASSERTION_FIELDS = new Set(['selector', 'visible', 'text', 'min_count', 'route']);
const ALLOWED_PRECONDITION_FIELDS = new Set(['selector', 'visible']);

/**
 * Validates the state contract section of a policy.
 * Ensures state definitions have valid structure, selectors, actions, and assertions.
 * Rejects unsupported contract fields instead of silently ignoring them.
 */
export function validateStateContract(policy) {
  if (!policy || typeof policy !== 'object') return;
  const states = policy.states || [];
  for (const s of states) {
    const id = s.state_id || s.name;
    if (!id || typeof id !== 'string') {
      throw new Error('state contract error: every state must have a non-empty string name or state_id');
    }

    // Check for unsupported fields in state definition
    for (const key of Object.keys(s)) {
      if (!ALLOWED_STATE_FIELDS.has(key)) {
        throw new Error(`unsupported state contract field: "${key}" in state "${id}"`);
      }
    }

    if (s.actions && !Array.isArray(s.actions)) {
      throw new Error(`state contract error: actions for state "${id}" must be an array`);
    }
    for (const action of s.actions || []) {
      for (const key of Object.keys(action)) {
        if (!ALLOWED_ACTION_FIELDS.has(key)) {
          throw new Error(`unsupported action field "${key}" in state "${id}"`);
        }
      }
      if (!ALLOWED_ACTION_TYPES.has(action.type)) {
        throw new Error(`unsupported action type "${action.type}" in state "${id}"`);
      }
    }

    if (s.assertions && !Array.isArray(s.assertions)) {
      throw new Error(`state contract error: assertions for state "${id}" must be an array`);
    }
    for (const assertion of s.assertions || []) {
      for (const key of Object.keys(assertion)) {
        if (!ALLOWED_ASSERTION_FIELDS.has(key)) {
          throw new Error(`unsupported assertion field "${key}" in state "${id}"`);
        }
      }
    }

    if (s.preconditions && !Array.isArray(s.preconditions)) {
      throw new Error(`state contract error: preconditions for state "${id}" must be an array`);
    }
    for (const pre of s.preconditions || []) {
      for (const key of Object.keys(pre)) {
        if (!ALLOWED_PRECONDITION_FIELDS.has(key)) {
          throw new Error(`unsupported precondition field "${key}" in state "${id}"`);
        }
      }
    }

    if (s.required_resources && !Array.isArray(s.required_resources)) {
      throw new Error(`state contract error: required_resources for state "${id}" must be an array`);
    }
  }

  if (policy.required_states && !Array.isArray(policy.required_states)) {
    throw new Error('state contract error: required_states must be an array of state IDs');
  }
}

/**
 * Checks preconditions for a state using locator wait.
 * Throws state_precondition_failed if any precondition fails.
 */
export async function checkStatePreconditions(page, state, remainingTime) {
  const preconditions = state.preconditions || [];
  const stateId = state.name || state.state_id || 'unknown';
  for (const pre of preconditions) {
    const loc = page.locator(pre.selector);
    const timeout = Math.min(typeof remainingTime === 'function' ? remainingTime() : 3000, 3000);
    try {
      if (pre.visible === true) {
        await loc.first().waitFor({ state: 'visible', timeout });
      } else if (pre.visible === false) {
        const count = await loc.count();
        if (count > 0) {
          await loc.first().waitFor({ state: 'hidden', timeout });
        }
      }
    } catch {
      throw new Error(`state_precondition_failed: ${stateId} - selector "${pre.selector}" expected visible=${pre.visible}`);
    }

    const count = await loc.count();
    const isVisible = count > 0 && (await loc.first().isVisible());
    if (pre.visible === true && !isVisible) {
      throw new Error(`state_precondition_failed: ${stateId} - selector "${pre.selector}" expected visible`);
    }
    if (pre.visible === false && isVisible) {
      throw new Error(`state_precondition_failed: ${stateId} - selector "${pre.selector}" expected not visible`);
    }
  }
}

/**
 * Executes state actions and validates post-assertions using Playwright locators.
 * Throws state_not_reached if actions fail to produce expected state.
 */
export async function executeStateActionsWithAssertions(page, state, remaining, policy) {
  const stateId = state.name || state.state_id || 'unknown';

  // 1. Preconditions
  await checkStatePreconditions(page, state, remaining);

  // 2. Action execution
  for (const action of state.actions || []) {
    if (action.type === 'scroll') {
      if (action.selector) {
        await page.locator(action.selector).scrollIntoViewIfNeeded({ timeout: remaining() });
      } else {
        await page.evaluate(y => window.scrollTo(0, y), Number(action.y) || 0);
      }
    } else if (action.type === 'click' || action.type === 'hover') {
      const loc = page.locator(action.selector);
      await loc[action.type]({ timeout: remaining() });
    } else {
      throw new Error(`unsupported action type "${action.type}" in state "${stateId}"`);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: remaining() }).catch(() => {});
  }

  // 3. Post-action assertions
  // Verify route if specified
  if (state.expected_route) {
    const currentPath = new URL(page.url()).pathname;
    if (currentPath !== state.expected_route) {
      throw new Error(`state_not_reached: ${stateId} - route mismatch, expected "${state.expected_route}" but reached "${currentPath}"`);
    }
  }

  // Verify assertions (elements, body portals, secondary expansions)
  for (const assertion of state.assertions || []) {
    const loc = page.locator(assertion.selector);
    const timeout = Math.min(typeof remaining === 'function' ? remaining() : 3000, 3000);

    if (assertion.visible === true) {
      try {
        await loc.first().waitFor({ state: 'visible', timeout });
      } catch {
        throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected visible (timed out after ${timeout}ms)`);
      }

      // Check min_count: every counted item must satisfy genuine visibility
      if (assertion.min_count) {
        const count = await loc.count();
        let visibleCount = 0;
        for (let i = 0; i < count; i++) {
          const item = loc.nth(i);
          if (await item.isVisible()) {
            const box = await item.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              visibleCount++;
            }
          }
        }
        if (visibleCount < assertion.min_count) {
          throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected at least ${assertion.min_count} visible items, found ${visibleCount}`);
        }
      }

      if (assertion.text) {
        const text = await loc.first().innerText();
        if (!text.includes(assertion.text)) {
          throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" text does not include "${assertion.text}" (actual: "${text}")`);
        }
      }
    } else if (assertion.visible === false) {
      const count = await loc.count();
      if (count > 0) {
        try {
          await loc.first().waitFor({ state: 'hidden', timeout });
        } catch {
          throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected not visible (still visible after ${timeout}ms)`);
        }
        const isVisible = await loc.first().isVisible();
        if (isVisible) {
          throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected not visible`);
        }
      }
    }
  }

  // 4. Required resources check
  for (const req of state.required_resources || []) {
    const selector = typeof req === 'string' ? req : req.selector;
    const loc = page.locator(selector);
    const count = await loc.count();
    if (count === 0) {
      throw new Error(`required_resource_missing: selector "${selector}" does not exist in DOM for state "${stateId}"`);
    }
    const isVisible = await loc.first().isVisible();
    if (!isVisible) {
      throw new Error(`required_resource_missing: selector "${selector}" is not visible for state "${stateId}"`);
    }
  }

  // 5. Restores state verification
  if (state.restores_state) {
    const targetState = (policy?.states || []).find(s => (s.name || s.state_id) === state.restores_state);
    if (!targetState) {
      throw new Error(`unknown target state "${state.restores_state}" for restores_state`);
    }
    // Verify each invariant assertion of target state holds
    for (const assertion of targetState.assertions || []) {
      const loc = page.locator(assertion.selector);
      const timeout = Math.min(typeof remaining === 'function' ? remaining() : 3000, 3000);
      if (assertion.visible === true) {
        try {
          await loc.first().waitFor({ state: 'visible', timeout });
        } catch {
          throw new Error(`state_restoration_failed: state "${stateId}" failed to restore visible invariant "${assertion.selector}" of "${state.restores_state}"`);
        }
      } else if (assertion.visible === false) {
        const count = await loc.count();
        if (count > 0) {
          try {
            await loc.first().waitFor({ state: 'hidden', timeout });
          } catch {
            throw new Error(`state_restoration_failed: state "${stateId}" failed to restore hidden invariant "${assertion.selector}" of "${state.restores_state}"`);
          }
          if (await loc.first().isVisible()) {
            throw new Error(`state_restoration_failed: state "${stateId}" failed to restore hidden invariant "${assertion.selector}" of "${state.restores_state}"`);
          }
        }
      }
    }
  }
}

/**
 * Inspects component-specific resources within the page DOM:
 * - Scoped to component selector + portals (excludes unrelated page assets)
 * - img/picture: currentSrc, decoded, candidate srcset gaps via parseSrcset
 * - CSS backgrounds: computed background-image URLs via postcss-value-parser
 * - inline SVGs: outerHTML markup saved as independent on-disk files with SHA256
 */
export async function inspectStateComponentResources(page, state, knownResources, root, contextInfo = {}) {
  const stateId = state.name || state.state_id || 'default';
  const captureId = contextInfo.capture_id || 'unknown-capture';
  const routeUrl = contextInfo.route || page.url();
  const viewport = contextInfo.viewport || { width: 1440, height: 1000 };
  const caseKey = `${routeUrl}::${viewport.width}x${viewport.height}::${stateId}`;

  const compSelector = state.component_selector || contextInfo.policy?.component_selector || (typeof contextInfo.policy?.component === 'string' ? `#${contextInfo.policy.component}` : null);
  const portalSelector = state.portal_selector || '#region-portal, .portal-overlay, [role="dialog"]';

  const rawDomResources = await page.evaluate(({ compSel, portalSel }) => {
    const roots = [];
    if (compSel) {
      const compEl = document.querySelector(compSel);
      if (compEl) roots.push(compEl);
    }
    if (portalSel) {
      const portalEls = document.querySelectorAll(portalSel);
      for (const el of portalEls) roots.push(el);
    }
    if (roots.length === 0) {
      roots.push(document.body);
    }

    // 1. img / picture within component roots
    const images = [];
    const seenImg = new Set();
    for (const root of roots) {
      const found = root.querySelectorAll('img');
      for (const img of found) {
        if (seenImg.has(img)) continue;
        seenImg.add(img);
        const rect = img.getBoundingClientRect();
        const style = window.getComputedStyle(img);
        images.push({
          src: img.src,
          currentSrc: img.currentSrc || img.src,
          rawSrcset: img.srcset || img.getAttribute('srcset') || '',
          alt: img.alt || '',
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          decoded: img.complete && img.naturalWidth > 0,
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        });
      }
    }

    // 2. CSS backgrounds within component roots
    const backgrounds = [];
    for (const root of roots) {
      const elements = [root, ...root.querySelectorAll('*')];
      for (const el of elements) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundImage;
        if (bg && bg !== 'none' && bg.includes('url(')) {
          const rect = el.getBoundingClientRect();
          backgrounds.push({
            tag: el.tagName.toLowerCase(),
            className: typeof el.className === 'string' ? el.className : '',
            id: el.id || '',
            rawBg: bg,
            visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          });
        }
      }
    }

    // 3. Inline SVGs within component roots
    const inlineSvgs = [];
    const seenSvg = new Set();
    for (const root of roots) {
      const svgs = root.querySelectorAll('svg');
      for (const svg of svgs) {
        if (seenSvg.has(svg)) continue;
        seenSvg.add(svg);
        const rect = svg.getBoundingClientRect();
        const style = window.getComputedStyle(svg);
        const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        inlineSvgs.push({
          id: svg.id || '',
          className: typeof svg.className === 'string' ? svg.className : (svg.className?.baseVal || ''),
          viewBox: svg.getAttribute('viewBox') || '',
          outerHTML: svg.outerHTML,
          visible: isVisible
        });
      }
    }

    return { images, backgrounds, inlineSvgs };
  }, { compSel: compSelector, portalSel: portalSelector });

  const stateResources = [];

  // Map images
  for (const img of rawDomResources.images) {
    if (!img.currentSrc) continue;
    let match = knownResources.find(r => (r.url === img.currentSrc || r.response_url === img.currentSrc) && r.status === 'saved');
    if (!match) {
      const redirectMatch = knownResources.find(r => r.url === img.currentSrc || r.response_url === img.currentSrc);
      if (redirectMatch && redirectMatch.status === 'redirect' && redirectMatch.response_url) {
        match = knownResources.find(r => (r.url === redirectMatch.response_url || r.response_url === redirectMatch.response_url) && r.status === 'saved');
      } else {
        match = redirectMatch;
      }
    }
    let verifiedOnDisk = false;
    let localSha = null;
    let rawSha = null;
    let localPath = null;

    if (match && match.status === 'saved') {
      localPath = match.local_path;
      localSha = match.local_sha256;
      rawSha = match.raw_sha256;
      if (localPath && fs.existsSync(safeFile(root, localPath))) {
        const diskContent = fs.readFileSync(safeFile(root, localPath));
        verifiedOnDisk = sha(diskContent) === match.local_sha256;
      }
    }

    // Identify uncaptured candidates from srcset using parseSrcset
    const uncapturedCandidates = [];
    if (img.rawSrcset) {
      try {
        const parsed = parseSrcset(img.rawSrcset);
        for (const c of parsed) {
          try {
            const fullCandidate = new URL(c.url, img.currentSrc).href;
            if (fullCandidate !== img.currentSrc && !knownResources.some(r => (r.url === fullCandidate || r.response_url === fullCandidate) && r.status === 'saved')) {
              uncapturedCandidates.push({
                url: fullCandidate,
                status: 'NOT_CAPTURED'
              });
            }
          } catch {}
        }
      } catch {}
    }

    stateResources.push({
      kind: 'image',
      origin: 'network',
      currentSrc: img.currentSrc,
      src: img.src,
      source_sha256: rawSha,
      local_path: localPath,
      local_sha256: localSha,
      verified_on_disk: verifiedOnDisk,
      decoded: img.decoded,
      natural_dimensions: { width: img.naturalWidth, height: img.naturalHeight },
      visible: img.visible,
      transform_reason: rawSha && localSha ? (rawSha === localSha ? 'none' : 'localized_url_rewriting') : 'unresolved',
      uncaptured_srcset_candidates: uncapturedCandidates
    });
  }

  // Map CSS backgrounds via postcss-value-parser
  for (const bg of rawDomResources.backgrounds) {
    const urls = [];
    try {
      const ast = valueParser(bg.rawBg);
      ast.walk(node => {
        if (node.type === 'function' && node.value.toLowerCase() === 'url') {
          const raw = valueParser.stringify(node.nodes).trim().replace(/^(['"])(.*)\1$/s, '$2');
          if (raw && !raw.startsWith('data:')) {
            try {
              urls.push(new URL(raw, routeUrl).href);
            } catch {}
          }
        }
      });
    } catch {}

    for (const bgUrl of urls) {
      let match = knownResources.find(r => (r.url === bgUrl || r.response_url === bgUrl) && r.status === 'saved');
      if (!match) {
        const redirectMatch = knownResources.find(r => r.url === bgUrl || r.response_url === bgUrl);
        if (redirectMatch && redirectMatch.status === 'redirect' && redirectMatch.response_url) {
          match = knownResources.find(r => (r.url === redirectMatch.response_url || r.response_url === redirectMatch.response_url) && r.status === 'saved');
        } else {
          match = redirectMatch;
        }
      }
      let verifiedOnDisk = false;
      let localSha = null;
      let rawSha = null;
      let localPath = null;

      if (match && match.status === 'saved') {
        localPath = match.local_path;
        localSha = match.local_sha256;
        rawSha = match.raw_sha256;
        if (localPath && fs.existsSync(safeFile(root, localPath))) {
          const diskContent = fs.readFileSync(safeFile(root, localPath));
          verifiedOnDisk = sha(diskContent) === match.local_sha256;
        }
      }

      stateResources.push({
        kind: 'css-background',
        origin: 'network',
        source_url: bgUrl,
        element_selector: `${bg.tag}${bg.id ? '#' + bg.id : ''}${bg.className ? '.' + bg.className.split(' ').join('.') : ''}`,
        source_sha256: rawSha,
        local_path: localPath,
        local_sha256: localSha,
        verified_on_disk: verifiedOnDisk,
        visible: bg.visible,
        transform_reason: rawSha && localSha ? (rawSha === localSha ? 'none' : 'localized_url_rewriting') : 'unresolved'
      });
    }
  }

  // Map inline SVGs: save outerHTML to disk as independent artifact with SHA256
  for (let idx = 0; idx < rawDomResources.inlineSvgs.length; idx++) {
    const svg = rawDomResources.inlineSvgs[idx];
    const svgSha = sha(Buffer.from(svg.outerHTML, 'utf8'));
    const svgRelPath = `pages/${captureId}/svg-${idx}-${svgSha.slice(0, 10)}.svg`;
    put(root, svgRelPath, svg.outerHTML, true);

    stateResources.push({
      kind: 'inline-svg',
      origin: 'inline',
      source_url: null,
      element_selector: `svg${svg.id ? '#' + svg.id : ''}${svg.className ? '.' + svg.className.split(' ').join('.') : ''}`,
      viewBox: svg.viewBox,
      source_sha256: svgSha,
      local_path: svgRelPath,
      local_sha256: svgSha,
      verified_on_disk: true,
      visible: svg.visible,
      transform_reason: 'inline_markup_saved_to_disk',
      markup_snippet: svg.outerHTML.slice(0, 120)
    });
  }

  return {
    capture_id: captureId,
    route: routeUrl,
    viewport,
    state_id: stateId,
    case_key: caseKey,
    resources: stateResources
  };
}

/**
 * Builds the comprehensive reports/component-handoff.json artifact.
 * Accurately associates each state record with its unique capture_id and composite case key.
 * Distinguishes required state definitions vs total required viewport cases.
 */
export function buildComponentHandoffReport(root, manifest, captures, stateResourceInventories, resources) {
  const policy = manifest.policy || {};
  const requiredStates = policy.required_states || [];
  const viewports = policy.viewports || [{ width: 1440, height: 1000 }];
  const routes = manifest.routes || (policy.url ? [{ url: policy.url, status: 'visited' }] : []);

  const totalRequiredCases = requiredStates.length * viewports.length;
  const stateMatrix = [];
  const resourceCatalog = [];
  const seenCatalogKeys = new Set();

  let actualValidCasesCount = 0;
  let verifiedFilesCount = 0;
  let missingFilesCount = 0;

  for (const inv of stateResourceInventories) {
    // Exact association by capture_id
    const capture = captures.find(c => c.capture_id === inv.capture_id);
    const isValidAssociation = Boolean(
      capture &&
      capture.state === inv.state_id &&
      capture.viewport.width === inv.viewport.width &&
      capture.viewport.height === inv.viewport.height
    );

    const stateRecord = {
      case_key: inv.case_key,
      state_id: inv.state_id,
      capture_id: inv.capture_id,
      captured: isValidAssociation,
      viewport: inv.viewport,
      route: inv.route,
      screenshot: capture?.files?.['screenshot.png']?.path || null,
      rendered_html: capture?.files?.['rendered.html']?.path || null,
      signals: capture?.files?.['signals.json']?.path || null,
      assertions_verified: isValidAssociation,
      resources_used: inv.resources
    };
    stateMatrix.push(stateRecord);

    if (isValidAssociation && requiredStates.includes(inv.state_id)) {
      actualValidCasesCount++;
    }

    for (const r of inv.resources) {
      const key = `${r.kind}:${r.origin}:${r.local_path || r.source_url || r.source_sha256}`;
      if (!seenCatalogKeys.has(key)) {
        seenCatalogKeys.add(key);
        resourceCatalog.push({
          id: `res-${resourceCatalog.length + 1}`,
          kind: r.kind,
          origin: r.origin,
          source_url: r.source_url || r.currentSrc || null,
          source_sha256: r.source_sha256,
          local_path: r.local_path,
          local_sha256: r.local_sha256,
          verified_on_disk: r.verified_on_disk,
          states_used: [inv.case_key],
          transform_reason: r.transform_reason,
          uncaptured_srcset_candidates: r.uncaptured_srcset_candidates || []
        });
      } else {
        const existing = resourceCatalog.find(entry => `${entry.kind}:${entry.origin}:${entry.local_path || entry.source_url || entry.source_sha256}` === key);
        if (existing && !existing.states_used.includes(inv.case_key)) {
          existing.states_used.push(inv.case_key);
        }
      }

      if (r.verified_on_disk) {
        verifiedFilesCount++;
      } else {
        missingFilesCount++;
      }
    }
  }

  // Identify any missing required cases
  const missingCases = [];
  for (const stateName of requiredStates) {
    for (const vp of viewports) {
      const found = stateMatrix.some(s => s.state_id === stateName && s.viewport.width === vp.width && s.viewport.height === vp.height && s.captured);
      if (!found) {
        missingCases.push({ state: stateName, viewport: vp });
      }
    }
  }

  const report = {
    schema: 1,
    run_id: manifest.run_id,
    component: policy.component || 'interactive-component',
    contract: {
      required_states: requiredStates,
      required_state_definitions: requiredStates.length,
      required_cases: totalRequiredCases,
      viewports
    },
    counts: {
      required_state_definitions: requiredStates.length,
      required_cases: totalRequiredCases,
      actual_valid_cases: actualValidCasesCount,
      missing_cases: missingCases.length,
      cataloged_resources: resourceCatalog.length,
      verified_files: verifiedFilesCount,
      missing_files: missingFilesCount
    },
    status: missingCases.length === 0 && missingFilesCount === 0 ? 'complete' : 'incomplete',
    states: stateMatrix,
    resource_catalog: resourceCatalog
  };

  put(root, 'reports/component-handoff.json', json(report));
  return report;
}

/**
 * Verifies component handoff integrity during verify() run.
 * Expected set is derived from original policy/manifest, NOT trusted from report.
 * Ensures:
 * 1. reports/component-handoff.json exists and conforms to schema/run_id
 * 2. Every required state definition and every required viewport case is verified
 * 3. Every referenced file (network and inline SVG) exists on disk and matches SHA256
 * 4. Counts are recalculated and validated against actual disk and matrix state
 * 5. Tampering with status/pass or blanking contract/states fails verification
 */
export function verifyStateHandoff(root, { requireHandoff = false, contract = null } = {}) {
  const errors = [];
  const handoffPath = safeFile(root, 'reports/component-handoff.json');

  if (!fs.existsSync(handoffPath)) {
    if (requireHandoff) {
      return { status: 'failed', errors: ['missing reports/component-handoff.json'] };
    }
    return { status: 'complete', skipped: true };
  }

  try {
    const handoff = readJSON(root, 'reports/component-handoff.json');
    const manifest = readJSON(root, 'manifest.json');

    if (handoff.schema !== 1 || handoff.run_id !== manifest.run_id) {
      errors.push('component handoff schema or run_id mismatch');
    }

    // Expected contract comes from manifest.policy or explicit contract parameter, NOT handoff report
    const policy = manifest.policy || {};
    const expectedRequiredStates = contract?.required_states || policy.required_states || [];
    const expectedViewports = contract?.viewports || policy.viewports || [];
    const expectedTotalCases = expectedRequiredStates.length * expectedViewports.length;

    // Check against blanked/tampered contract in handoff report
    if (expectedRequiredStates.length > 0) {
      if (!handoff.contract || !Array.isArray(handoff.contract.required_states) || handoff.contract.required_states.length === 0) {
        errors.push('handoff contract is empty or tampered');
      }
      if (!Array.isArray(handoff.states) || handoff.states.length === 0) {
        errors.push('handoff states matrix is empty');
      }
      if (!Array.isArray(handoff.resource_catalog) || handoff.resource_catalog.length === 0) {
        errors.push('handoff resource catalog is empty');
      }
    }

    const captures = manifest.captures || [];
    let recalculatedValidCases = 0;

    // Check each required case
    for (const reqState of expectedRequiredStates) {
      for (const vp of expectedViewports) {
        // Verify in manifest.captures
        const cap = captures.find(c => c.state === reqState && c.viewport.width === vp.width && c.viewport.height === vp.height);
        if (!cap) {
          errors.push(`missing capture for required case: ${reqState} at ${vp.width}x${vp.height}`);
          continue;
        }

        // Verify in handoff.states matrix
        const handoffState = (handoff.states || []).find(s => s.state_id === reqState && s.viewport?.width === vp.width && s.viewport?.height === vp.height && s.capture_id === cap.capture_id);
        if (!handoffState || !handoffState.captured) {
          errors.push(`missing or invalid handoff state record for ${reqState} at ${vp.width}x${vp.height}`);
          continue;
        }

        recalculatedValidCases++;

        // Verify files associated with this case
        for (const fname of ['screenshot.png', 'rendered.html', 'signals.json']) {
          const f = cap.files?.[fname];
          if (!f || !fs.existsSync(safeFile(root, f.path))) {
            errors.push(`missing evidence file for case ${reqState}: ${f?.path || fname}`);
          }
        }
      }
    }

    // Verify disk files and SHA256 for all cataloged resources (both network and inline-svg)
    let recalculatedVerifiedFiles = 0;
    let recalculatedMissingFiles = 0;

    for (const res of handoff.resource_catalog || []) {
      if (!res.local_path) {
        errors.push(`resource has no local_path: ${res.source_url || res.id}`);
        recalculatedMissingFiles++;
        continue;
      }

      const fullLocal = safeFile(root, res.local_path);
      if (!fs.existsSync(fullLocal)) {
        errors.push(`missing resource file on disk: ${res.local_path}`);
        recalculatedMissingFiles++;
        continue;
      }

      const content = fs.readFileSync(fullLocal);
      const actualSha = sha(content);
      if (actualSha !== res.local_sha256) {
        errors.push(`sha mismatch for ${res.local_path}: expected ${res.local_sha256}, got ${actualSha}`);
        recalculatedMissingFiles++;
        continue;
      }

      // If inline SVG, also verify that the rendered DOM for its states contains this SVG markup
      if (res.origin === 'inline') {
        const correspondingState = (handoff.states || []).find(s => res.states_used?.includes(s.case_key));
        if (correspondingState && correspondingState.rendered_html) {
          const domHtml = fs.readFileSync(safeFile(root, correspondingState.rendered_html), 'utf8');
          if (!domHtml.includes(actualSha) && !domHtml.includes(content.toString('utf8').trim())) {
            // Also check viewBox or partial snippet
            if (res.viewBox && !domHtml.includes(res.viewBox)) {
              errors.push(`inline SVG in ${res.local_path} not found in corresponding rendered.html`);
            }
          }
        }
      }

      recalculatedVerifiedFiles++;
    }

    // Anti-tamper count validation
    if (handoff.counts) {
      if (expectedRequiredStates.length > 0 && handoff.counts.actual_valid_cases !== recalculatedValidCases) {
        errors.push(`anti-tamper count mismatch: handoff claims ${handoff.counts.actual_valid_cases} valid cases, recalculated ${recalculatedValidCases}`);
      }
      if (handoff.counts.missing_files !== recalculatedMissingFiles) {
        errors.push(`anti-tamper count mismatch: handoff claims ${handoff.counts.missing_files} missing files, recalculated ${recalculatedMissingFiles}`);
      }
    }

    if (errors.length > 0) {
      return {
        status: 'failed',
        errors,
        counts: handoff.counts
      };
    }

    return {
      status: 'complete',
      verified_cases: recalculatedValidCases,
      cataloged_resources: (handoff.resource_catalog || []).length,
      verified_files: recalculatedVerifiedFiles
    };
  } catch (err) {
    return { status: 'failed', errors: [err.message] };
  }
}
