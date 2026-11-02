/**
 * Cloudflare platform limits that Worker budgets are measured against, for the
 * Workers Free plan (the smallest supported deployment). Checked against
 * Cloudflare's docs on 2026-11-01; recheck them when Cloudflare announces a change:
 * - https://developers.cloudflare.com/d1/platform/limits/
 * - https://developers.cloudflare.com/workers/platform/limits/
 * - https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
 *
 * Feature batch sizes are not derived from these values. Their budget tests measure
 * worst-case D1 queries against D1_QUERIES_PER_INVOCATION, so a lowered limit fails
 * those tests and a raised one shows where batches can grow.
 */

/** D1 queries per Worker or Durable Object invocation. A `db.batch()` counts once. */
export const D1_QUERIES_PER_INVOCATION = 50;

/** Bound parameters in one D1 statement. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** Keys one R2 `list()` returns or one `delete()` removes. */
export const R2_KEYS_PER_CALL = 1000;

/** Outgoing connections one invocation may have waiting for response headers. */
export const SIMULTANEOUS_OPEN_CONNECTIONS = 6;
