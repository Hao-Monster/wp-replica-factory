import fs from 'node:fs';
import path from 'node:path';
import { sha, safeFile, readJSON, json, put } from './core.mjs';

/**
 * Validates the state contract section of a policy.
 * Ensures state definitions have valid structure, selectors, actions, and assertions.
 */
export function validateStateContract(policy) {
  if (!policy || typeof policy !== 'object') return;
  const states = policy.states || [];
  for (const s of states) {
    const id = s.state_id || s.name;
    if (!id || typeof id !== 'string') {
      throw new Error('state contract error: every state must have a non-empty string name or state_id');
    }
    if (s.actions && !Array.isArray(s.actions)) {
      throw new Error(`state contract error: actions for state "${id}" must be an array`);
    }
    if (s.assertions && !Array.isArray(s.assertions)) {
      throw new Error(`state contract error: assertions for state "${id}" must be an array`);
    }
    if (s.preconditions && !Array.isArray(s.preconditions)) {
      throw new Error(`state contract error: preconditions for state "${id}" must be an array`);
    }
  }
  if (policy.required_states && !Array.isArray(policy.required_states)) {
    throw new Error('state contract error: required_states must be an array of state IDs');
  }
}

/**
 * Checks preconditions for a state.
 * Throws state_precondition_failed if any precondition fails.
 */
export async function checkStatePreconditions(page, state, remainingTime) {
  const preconditions = state.preconditions || [];
  for (const pre of preconditions) {
    const loc = page.locator(pre.selector);
    const count = await loc.count();
    const isVisible = count > 0 && (await loc.first().isVisible());
    if (pre.visible === true && !isVisible) {
      throw new Error(`state_precondition_failed: ${state.name || state.state_id} - selector "${pre.selector}" expected visible`);
    }
    if (pre.visible === false && isVisible) {
      throw new Error(`state_precondition_failed: ${state.name || state.state_id} - selector "${pre.selector}" expected not visible`);
    }
  }
}

/**
 * Executes state actions and validates post-assertions.
 * Throws state_not_reached if actions fail to produce expected state.
 */
export async function executeStateActionsWithAssertions(page, state, remaining) {
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
    const count = await loc.count();
    const isVisible = count > 0 && (await loc.first().isVisible());

    if (assertion.visible === true) {
      if (!isVisible) {
        throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected visible`);
      }
      if (assertion.min_count && count < assertion.min_count) {
        throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected at least ${assertion.min_count} items, found ${count}`);
      }
      if (assertion.text) {
        const text = await loc.first().innerText();
        if (!text.includes(assertion.text)) {
          throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" text does not include "${assertion.text}" (actual: "${text}")`);
        }
      }
    } else if (assertion.visible === false) {
      if (isVisible) {
        throw new Error(`state_not_reached: ${stateId} - selector "${assertion.selector}" expected not visible`);
      }
    }
  }
}

/**
 * Inspects the page DOM to extract component-specific resources:
 * - img/picture: currentSrc, decoded, candidate srcset gaps
 * - CSS backgrounds: computed background-image URLs
 * - inline SVGs: viewBox, outerHTML markup and hash
 */
export async function inspectStateComponentResources(page, state, knownResources, root) {
  const stateId = state.name || state.state_id || 'default';

  const rawDomResources = await page.evaluate(() => {
    // 1. img / picture
    const images = [...document.querySelectorAll('img')].map(img => {
      let srcsetItems = [];
      if (img.srcset) {
        srcsetItems = img.srcset.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
      }
      return {
        src: img.src,
        currentSrc: img.currentSrc || img.src,
        srcset: srcsetItems,
        alt: img.alt || '',
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        decoded: img.complete && img.naturalWidth > 0,
        visible: img.offsetWidth > 0 && img.offsetHeight > 0 && window.getComputedStyle(img).display !== 'none'
      };
    });

    // 2. CSS backgrounds
    const backgrounds = [];
    const elements = [...document.querySelectorAll('*')];
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none' && bg.startsWith('url(')) {
        const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
        if (match && match[1]) {
          try {
            const resolved = new URL(match[1], window.location.href).href;
            backgrounds.push({
              tag: el.tagName.toLowerCase(),
              className: typeof el.className === 'string' ? el.className : '',
              id: el.id || '',
              url: resolved,
              visible: el.offsetWidth > 0 && el.offsetHeight > 0 && style.display !== 'none'
            });
          } catch {}
        }
      }
    }

    // 3. Inline SVGs
    const inlineSvgs = [...document.querySelectorAll('svg')].map(svg => {
      const rect = svg.getBoundingClientRect();
      const style = window.getComputedStyle(svg);
      const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      return {
        id: svg.id || '',
        className: typeof svg.className === 'string' ? svg.className : (svg.className?.baseVal || ''),
        viewBox: svg.getAttribute('viewBox') || '',
        outerHTML: svg.outerHTML,
        visible: isVisible
      };
    });

    return { images, backgrounds, inlineSvgs };
  });

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
    let rawPath = null;

    if (match && match.status === 'saved') {
      localPath = match.local_path;
      rawPath = match.raw_path;
      localSha = match.local_sha256;
      rawSha = match.raw_sha256;
      if (localPath && fs.existsSync(safeFile(root, localPath))) {
        const diskContent = fs.readFileSync(safeFile(root, localPath));
        verifiedOnDisk = sha(diskContent) === match.local_sha256;
      }
    }

    // Identify uncaptured candidates from srcset
    const uncapturedCandidates = img.srcset
      .filter(candidateUrl => {
        try {
          const fullCandidate = new URL(candidateUrl, img.currentSrc).href;
          return fullCandidate !== img.currentSrc && !knownResources.some(r => r.url === fullCandidate && r.status === 'saved');
        } catch {
          return false;
        }
      })
      .map(c => ({ url: c, status: 'NOT_CAPTURED' }));

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

  // Map CSS backgrounds
  for (const bg of rawDomResources.backgrounds) {
    let match = knownResources.find(r => (r.url === bg.url || r.response_url === bg.url) && r.status === 'saved');
    if (!match) {
      const redirectMatch = knownResources.find(r => r.url === bg.url || r.response_url === bg.url);
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
      source_url: bg.url,
      element_selector: `${bg.tag}${bg.id ? '#' + bg.id : ''}${bg.className ? '.' + bg.className.split(' ').join('.') : ''}`,
      source_sha256: rawSha,
      local_path: localPath,
      local_sha256: localSha,
      verified_on_disk: verifiedOnDisk,
      visible: bg.visible,
      transform_reason: rawSha && localSha ? (rawSha === localSha ? 'none' : 'localized_url_rewriting') : 'unresolved'
    });
  }

  // Map inline SVGs
  for (const svg of rawDomResources.inlineSvgs) {
    const svgSha = sha(Buffer.from(svg.outerHTML, 'utf8'));
    stateResources.push({
      kind: 'inline-svg',
      origin: 'inline',
      source_url: null,
      element_selector: `svg${svg.id ? '#' + svg.id : ''}${svg.className ? '.' + svg.className.split(' ').join('.') : ''}`,
      viewBox: svg.viewBox,
      source_sha256: svgSha,
      local_path: null,
      local_sha256: svgSha,
      verified_on_disk: true, // inline SVG is preserved in rendered.html
      visible: svg.visible,
      transform_reason: 'inline_markup_preserved',
      markup_snippet: svg.outerHTML.slice(0, 120)
    });
  }

  return {
    state_id: stateId,
    resources: stateResources
  };
}

/**
 * Builds the comprehensive reports/component-handoff.json artifact.
 */
export function buildComponentHandoffReport(root, manifest, captures, stateResourceInventories, resources) {
  const policy = manifest.policy || {};
  const requiredStates = policy.required_states || [];
  const stateMatrix = [];
  const resourceCatalog = [];
  const seenCatalogKeys = new Set();

  let verifiedStatesCount = 0;
  let missingStatesCount = 0;
  let verifiedFilesCount = 0;
  let missingFilesCount = 0;

  for (const inv of stateResourceInventories) {
    const capture = captures.find(c => c.state === inv.state_id);
    const stateRecord = {
      state_id: inv.state_id,
      captured: Boolean(capture),
      capture_id: capture?.capture_id || null,
      viewport: capture?.viewport || null,
      route: capture?.url || null,
      screenshot: capture?.files?.['screenshot.png']?.path || null,
      rendered_html: capture?.files?.['rendered.html']?.path || null,
      signals: capture?.files?.['signals.json']?.path || null,
      assertions_verified: Boolean(capture),
      resources_used: inv.resources
    };
    stateMatrix.push(stateRecord);

    if (capture) {
      verifiedStatesCount++;
    }

    for (const r of inv.resources) {
      const key = `${r.kind}:${r.origin}:${r.source_url || r.source_sha256}`;
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
          states_used: [inv.state_id],
          transform_reason: r.transform_reason,
          uncaptured_srcset_candidates: r.uncaptured_srcset_candidates || []
        });
      } else {
        const existing = resourceCatalog.find(entry => `${entry.kind}:${entry.origin}:${entry.source_url || entry.source_sha256}` === key);
        if (existing && !existing.states_used.includes(inv.state_id)) {
          existing.states_used.push(inv.state_id);
        }
      }

      if (r.origin === 'network') {
        if (r.verified_on_disk) {
          verifiedFilesCount++;
        } else {
          missingFilesCount++;
        }
      }
    }
  }

  // Count missing required states
  const capturedStateIds = new Set(captures.map(c => c.state));
  for (const req of requiredStates) {
    if (!capturedStateIds.has(req)) {
      missingStatesCount++;
    }
  }

  const report = {
    schema: 1,
    run_id: manifest.run_id,
    component: policy.component || 'interactive-component',
    contract: {
      required_states: requiredStates,
      total_required: requiredStates.length,
      viewports: policy.viewports || []
    },
    counts: {
      expected_states: requiredStates.length,
      captured_states: captures.length,
      verified_states: verifiedStatesCount,
      missing_states: missingStatesCount,
      cataloged_resources: resourceCatalog.length,
      verified_files: verifiedFilesCount,
      missing_files: missingFilesCount
    },
    status: missingStatesCount === 0 && missingFilesCount === 0 ? 'complete' : 'incomplete',
    states: stateMatrix,
    resource_catalog: resourceCatalog
  };

  put(root, 'reports/component-handoff.json', json(report));
  return report;
}

/**
 * Verifies component handoff integrity during verify() run.
 * Ensures:
 * 1. reports/component-handoff.json exists and adheres to schema
 * 2. Every required state was captured and verified across viewports
 * 3. Every referenced network file exists on disk and matches SHA256
 * 4. No files or states are missing
 * 5. Tampering with status/pass cannot bypass missing disk files or missing states
 */
export function verifyStateHandoff(root, { requireHandoff = false } = {}) {
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

    const requiredStates = handoff.contract?.required_states || [];
    const captures = manifest.captures || [];

    // Check required states
    for (const req of requiredStates) {
      const foundInHandoff = handoff.states?.find(s => s.state_id === req);
      if (!foundInHandoff || !foundInHandoff.captured) {
        errors.push(`missing required state in handoff report: ${req}`);
      }
      for (const vp of manifest.policy?.viewports || []) {
        const captured = captures.some(c => c.state === req && c.viewport.width === vp.width && c.viewport.height === vp.height);
        if (!captured) {
          errors.push(`missing required state capture for ${req} at ${vp.width}x${vp.height}`);
        }
      }
    }

    // Verify disk files for cataloged resources
    for (const res of handoff.resource_catalog || []) {
      if (res.origin === 'network') {
        if (!res.local_path) {
          errors.push(`network resource has no local_path: ${res.source_url}`);
          continue;
        }
        const fullLocal = safeFile(root, res.local_path);
        if (!fs.existsSync(fullLocal)) {
          errors.push(`missing resource file on disk: ${res.local_path}`);
          continue;
        }
        const content = fs.readFileSync(fullLocal);
        const actualSha = sha(content);
        if (actualSha !== res.local_sha256) {
          errors.push(`sha mismatch for ${res.local_path}: expected ${res.local_sha256}, got ${actualSha}`);
        }
      }
    }

    // Anti-tamper verification: if errors exist, status cannot be complete
    if (errors.length > 0) {
      return {
        status: 'failed',
        errors,
        counts: handoff.counts
      };
    }

    return {
      status: 'complete',
      verified_states: handoff.counts?.verified_states,
      cataloged_resources: handoff.counts?.cataloged_resources,
      verified_files: handoff.counts?.verified_files
    };
  } catch (err) {
    return { status: 'failed', errors: [err.message] };
  }
}
