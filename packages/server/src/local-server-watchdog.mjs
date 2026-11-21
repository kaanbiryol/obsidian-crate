import { setTimeout as delay } from 'node:timers/promises';

/** Watches a running Workers runtime. Miniflare restarts a crashed workerd on its own;
 * if that restart fails, every request fails while the process stays up. After `limit`
 * missed probes in a row, `failed` rejects so serving stops and the process exits,
 * letting its service manager (Docker, launchd, systemd) start a fresh one.
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<void>} options.probe Rejects when the runtime cannot answer.
 * @param {number} [options.interval]
 * @param {number} [options.timeout] Milliseconds one probe may take.
 * @param {number} [options.limit] */
export function watchRuntime({ probe, interval = 15_000, timeout = 10_000, limit = 3 }) {
	const controller = new AbortController();
	const { signal } = controller;
	/** @type {Promise<never>} */
	const failed = new Promise((_, reject) => {
		void (async () => {
			let misses = 0;
			while (!signal.aborted) {
				try { await delay(interval, undefined, { signal }); } catch { return; }
				try {
					await probe(AbortSignal.any([signal, AbortSignal.timeout(timeout)]));
					misses = 0;
				} catch (error) {
					if (signal.aborted) return;
					if (++misses >= limit) {
						reject(new Error(`The Workers runtime stopped responding (${error instanceof Error ? error.message : String(error)}). Crate is stopping so its service manager can restart it.`, { cause: error }));
						return;
					}
				}
			}
		})();
	});
	// Callers race on `failed`; a rejection before they do must not crash the process.
	failed.catch(() => {});
	return { failed, close() { controller.abort(); } };
}
