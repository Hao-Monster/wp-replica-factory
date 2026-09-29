/**
 * Reference Pipeline – Persistent Task Queue
 *
 * Promotes the Crawlee RequestQueue spike (tools/spike/crawlee-queue.mjs)
 * to a formal, importable module for the reference pipeline.
 *
 * Upstream: @crawlee/core@3.18.1 (Apache-2.0)
 * Actual import: tools/downloader/node_modules/@crawlee/core
 *
 * Key invariants:
 * - Same URL in different states/viewports/DPR → distinct tasks (no silent merge)
 * - Query parameters are preserved in uniqueKey (not stripped)
 * - Route-typed fragments are separated from state metadata
 * - purgeOnStart defaults false to support resume
 * - Tasks are only marked handled AFTER file write + digest verify
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuse Crawlee from the already-installed downloader node_modules
const downloaderRequire = createRequire(
  path.resolve(__dirname, '../downloader/package.json')
);
const { RequestQueue, Configuration } = downloaderRequire('@crawlee/core');

export { RequestQueue, Configuration };

/**
 * Builds a composite uniqueKey that preserves:
 * - Full pathname + query string (no query-stripping)
 * - State identity (interactive UI state, not route fragment)
 * - Viewport dimensions (width x height)
 * - Config version (bumping breaks resume into a new logical run)
 *
 * Fragment (#...) is intentionally excluded from the base URL component
 * because route-typed fragments are treated as separate state metadata,
 * not URL identity. This avoids collisions like /#home vs /#catalog.
 *
 * @param {object} params
 * @param {string} params.url          - Absolute URL (query preserved)
 * @param {string} [params.stateId]    - State identifier, default 'default'
 * @param {string} [params.viewport]   - e.g. '1440x1000'
 * @param {number} [params.dpr]        - Device pixel ratio, default 1
 * @param {string} [params.configVer]  - Config version tag, default 'v1'
 * @returns {string}
 */
export function buildTaskKey({ url, stateId = 'default', viewport = '1440x1000', dpr = 1, configVer = 'v1' }) {
  if (!url || typeof url !== 'string') throw new Error('url must be a non-empty string');
  const parsed = new URL(url);
  // Base: protocol + host + pathname + search; NO hash
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  return `${base}\x00state=${stateId}\x00vp=${viewport}\x00dpr=${dpr}\x00cfg=${configVer}`;
}

/**
 * Opens (or resumes) a named Crawlee RequestQueue backed to storageDir.
 *
 * @param {object} options
 * @param {string} options.storageDir   - Absolute path for persistent storage
 * @param {string} [options.queueName]  - Queue name (default: 'pipeline-queue')
 * @param {boolean} [options.purgeOnStart] - Purge existing queue (only for fresh start)
 * @returns {Promise<PipelineQueue>}
 */
export async function openQueue({ storageDir, queueName = 'pipeline-queue', purgeOnStart = false }) {
  if (!storageDir) throw new Error('storageDir is required');

  const cfg = Configuration.getGlobalConfig();
  cfg.set('storageDir', storageDir);
  cfg.set('purgeOnStart', purgeOnStart);

  // Also set env so any sub-process that calls Crawlee sees the same dir
  process.env.CRAWLEE_STORAGE_DIR = storageDir;

  const rawQueue = await RequestQueue.open(queueName);

  return new PipelineQueue(rawQueue, queueName);
}

/**
 * Managed wrapper around a Crawlee RequestQueue.
 * Provides pipeline-specific enqueue / fetch / mark-handled / stats.
 */
export class PipelineQueue {
  /** @param {import('@crawlee/core').RequestQueue} raw */
  constructor(raw, name) {
    this._raw = raw;
    this.name = name;
  }

  /**
   * Enqueue a task. Returns { uniqueKey, wasAlreadyPresent, requestId }.
   * Idempotent – safe to call multiple times with the same parameters.
   *
   * @param {object} params
   * @param {string} params.url
   * @param {string} [params.stateId]
   * @param {string} [params.viewport]
   * @param {number} [params.dpr]
   * @param {string} [params.configVer]
   * @param {object} [params.userData]   - Extra metadata stored with the task
   */
  async enqueue({ url, stateId = 'default', viewport = '1440x1000', dpr = 1, configVer = 'v1', userData = {} }) {
    const uniqueKey = buildTaskKey({ url, stateId, viewport, dpr, configVer });
    const result = await this._raw.addRequest({
      url,
      uniqueKey,
      userData: { ...userData, stateId, viewport, dpr, configVer }
    });
    return { uniqueKey, wasAlreadyPresent: result.wasAlreadyPresent, requestId: result.requestId };
  }

  /**
   * Fetch the next pending task. Returns null when queue is empty this cycle.
   */
  async fetchNext() {
    return this._raw.fetchNextRequest();
  }

  /**
   * Mark a task as successfully handled.
   * MUST only be called after output files are written and digests verified.
   *
   * @param {import('@crawlee/core').Request} request
   */
  async markHandled(request) {
    if (!request) return;
    await this._raw.markRequestHandled(request);
  }

  /**
   * Mark a task as failed (will be retried or left in failed state).
   *
   * @param {import('@crawlee/core').Request} request
   * @param {Error|string} err
   */
  async markFailed(request, err) {
    if (!request) return;
    await this._raw.reclaimRequest(request);
  }

  /**
   * Returns current queue statistics.
   * isFinished is true only when ALL enqueued tasks are handled.
   * Queue exhausted ≠ site complete (some tasks may be pending discovery).
   *
   * @returns {Promise<QueueStats>}
   */
  async getStats() {
    const isFinished = await this._raw.isFinished();
    const info = await this._raw.getInfo();
    return {
      queueName: this.name,
      total: info?.totalRequestCount ?? 0,
      handled: info?.handledRequestCount ?? 0,
      pending: info?.pendingRequestCount ?? 0,
      isFinished
    };
  }
}
