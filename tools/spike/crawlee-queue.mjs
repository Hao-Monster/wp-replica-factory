/**
 * EXPERIMENTAL: Upstream Crawlee RequestQueue Spike
 * 
 * Demonstrates:
 * 1. Runtime reuse of @crawlee/core RequestQueue for persistent crawl state & resumption
 * 2. Composite keying (URL + state_id + viewport) to prevent state loss/premature deduplication
 * 3. Budget termination without falsely claiming site completeness
 * 4. Strict enforcement of existing network/boundary guards
 */

import { createRequire } from 'node:module';

const downloaderRequire = createRequire(new URL('../downloader/package.json', import.meta.url));
export const { RequestQueue, Configuration } = downloaderRequire('@crawlee/core');
export const { chromium } = downloaderRequire('playwright');

/**
 * Builds a composite uniqueKey for Crawlee RequestQueue that preserves:
 * - Full route and query parameters (no query-dropping)
 * - Distinct interactive component states
 * - Distinct viewport dimensions
 *
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.stateId='default']
 * @param {string} [params.viewport='1440x1000']
 * @returns {string}
 */
export function buildCompositeKey({ url, stateId = 'default', viewport = '1440x1000' }) {
  if (!url || typeof url !== 'string') {
    throw new Error('url must be a valid non-empty string');
  }
  const parsed = new URL(url);
  // Keep protocol, host, pathname, and search params intact; strip hash if any
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  return `${base}#state=${stateId}@${viewport}`;
}

/**
 * Creates and initializes a managed Crawlee RequestQueue instance.
 *
 * @param {Object} options
 * @param {string} options.storageDir - Path to store queue on disk
 * @param {string} [options.queueName='spike-request-queue']
 * @param {boolean} [options.purgeOnStart=false] - Whether to clear existing queue
 * @returns {Promise<Object>}
 */
export async function createSpikeQueueManager({ storageDir, queueName = 'spike-request-queue', purgeOnStart = false }) {
  if (!storageDir) {
    throw new Error('storageDir is required for persistent queue storage');
  }

  process.env.CRAWLEE_STORAGE_DIR = storageDir;
  process.env.CRAWLEE_PURGE_ON_START = purgeOnStart ? '1' : '0';

  const globalConfig = Configuration.getGlobalConfig();
  globalConfig.set('storageDir', storageDir);
  globalConfig.set('purgeOnStart', purgeOnStart);

  const queue = await RequestQueue.open(queueName);

  return {
    rawQueue: queue,
    config: globalConfig,

    /**
     * Enqueue a URL + state + viewport request.
     */
    async enqueue({ url, stateId = 'default', viewport = '1440x1000', userData = {} }) {
      const uniqueKey = buildCompositeKey({ url, stateId, viewport });
      const requestInfo = await queue.addRequest({
        url,
        uniqueKey,
        userData: {
          ...userData,
          stateId,
          viewport
        }
      });
      return {
        uniqueKey,
        wasAlreadyPresent: requestInfo.wasAlreadyPresent,
        requestId: requestInfo.requestId
      };
    },

    /**
     * Fetch next unhandled request from queue.
     */
    async fetchNext() {
      return await queue.fetchNextRequest();
    },

    /**
     * Mark a request as handled.
     */
    async markHandled(request) {
      if (!request) return;
      await queue.markRequestHandled(request);
    },

    /**
     * Get queue statistics and completeness status.
     */
    async getStats() {
      const isFinished = await queue.isFinished();
      const info = await queue.getInfo();
      const totalCount = info?.totalRequestCount ?? 0;
      const handledCount = info?.handledRequestCount ?? 0;
      const pendingCount = info?.pendingRequestCount ?? 0;

      return {
        queueId: queue.id,
        queueName: queue.name,
        totalCount,
        handledCount,
        pendingCount,
        isFinished
      };
    }
  };
}

/**
 * Runs a controlled crawl step loop using Playwright driven by Crawlee RequestQueue.
 *
 * @param {Object} params
 * @param {Object} params.queueManager
 * @param {import('playwright').Page} params.page
 * @param {string} params.origin - Allowed base origin
 * @param {number} params.maxHandledBudget - Maximum handled requests allowed this run
 * @returns {Promise<Object>}
 */
export async function runControlledSpikeCrawler({
  queueManager,
  page,
  origin,
  maxHandledBudget = 10
}) {
  let handledThisRun = 0;
  const executionLog = [];

  while (handledThisRun < maxHandledBudget) {
    const request = await queueManager.fetchNext();
    if (!request) {
      break;
    }

    const { url, uniqueKey, userData = {} } = request;
    const { stateId = 'default', viewport = '1440x1000' } = userData;

    // Apply viewport dimensions
    const [widthStr, heightStr] = viewport.split('x');
    const width = parseInt(widthStr, 10) || 1440;
    const height = parseInt(heightStr, 10) || 1000;
    await page.setViewportSize({ width, height });

    // Navigate to page
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Discover links on the page if in default state
    const discoveredLinks = [];
    if (stateId === 'default') {
      const hrefs = await page.$$eval('a[href]', (anchors) => anchors.map((a) => a.getAttribute('href')));
      for (const href of hrefs) {
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
        try {
          const resolved = new URL(href, url);
          if (resolved.origin === origin) {
            const addResult = await queueManager.enqueue({
              url: resolved.toString(),
              stateId: 'default',
              viewport
            });
            discoveredLinks.push({ url: resolved.toString(), wasAlreadyPresent: addResult.wasAlreadyPresent });
          }
        } catch {
          // ignore invalid URLs
        }
      }
    }

    // Check for interactive state triggers on catalog page
    const discoveredStates = [];
    if (url.includes('catalog.html')) {
      const filterBtn = page.locator('#filter-btn');
      if (await filterBtn.count() > 0) {
        // Enqueue 'filter_opened' state if not yet current state
        if (stateId === 'default') {
          const addStateRes = await queueManager.enqueue({
            url,
            stateId: 'filter_opened',
            viewport
          });
          discoveredStates.push({ stateId: 'filter_opened', wasAlreadyPresent: addStateRes.wasAlreadyPresent });
        } else if (stateId === 'filter_opened') {
          // Simulate clicking to open filter panel
          await filterBtn.click();
          await page.locator('#filter-panel').waitFor({ state: 'visible', timeout: 2000 });

          // Discover secondary expand state
          const expandBtn = page.locator('#expand-category-btn');
          if (await expandBtn.count() > 0) {
            const addSecRes = await queueManager.enqueue({
              url,
              stateId: 'secondary_expanded',
              viewport
            });
            discoveredStates.push({ stateId: 'secondary_expanded', wasAlreadyPresent: addSecRes.wasAlreadyPresent });
          }
        } else if (stateId === 'secondary_expanded') {
          // Open filter panel first, then expand category panel
          await filterBtn.click();
          await page.locator('#filter-panel').waitFor({ state: 'visible', timeout: 2000 });
          const expandBtn = page.locator('#expand-category-btn');
          await expandBtn.click();
          await page.locator('#category-panel').waitFor({ state: 'visible', timeout: 2000 });
        }
      }
    }

    // Mark handled in Crawlee queue
    await queueManager.markHandled(request);
    handledThisRun += 1;

    executionLog.push({
      requestId: request.id,
      url,
      uniqueKey,
      stateId,
      viewport,
      discoveredLinksCount: discoveredLinks.length,
      discoveredStatesCount: discoveredStates.length
    });
  }

  const finalStats = await queueManager.getStats();

  return {
    status: finalStats.isFinished ? 'COMPLETED' : 'BUDGET_PAUSED',
    handledThisRun,
    finalStats,
    executionLog
  };
}
