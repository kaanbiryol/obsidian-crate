import { setTimeout as delay } from 'node:timers/promises';

/** Verify the public route reaches this running instance, not a stale tunnel. */
export function monitorPublicReadiness({ origin, instance, signal, fetchPublic = fetch,
	interval = 5000, onChange = () => {} }) {
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let ready = false;
	const done = (async () => {
		onChange(false);
		while (!combined.aborted) {
			let reachable = false;
			try {
				const response = await fetchPublic(`${origin}/__crate/ready`, {
					redirect: 'error', cache: 'no-store', signal: AbortSignal.any([combined, AbortSignal.timeout(5000)]),
				});
				if (response.ok) {
					const reader = response.body?.getReader();
					if (reader) {
						let body = '', size = 0;
						try {
							while (true) {
								const chunk = await reader.read();
								if (chunk.done) break;
								size += chunk.value.byteLength;
								if (size > 1024) throw new Error('Unexpected readiness response');
								body += new TextDecoder().decode(chunk.value);
							}
							reachable = JSON.parse(body).instance === instance;
						} finally { await reader.cancel(); }
					}
				}
			} catch { /* DNS and connection errors are expected while a tunnel starts. */ }
			if (combined.aborted) break;
			if (reachable !== ready) { ready = reachable; onChange(ready); }
			try { await delay(ready ? Math.max(interval, 30_000) : interval, undefined, { signal: combined }); }
			catch { break; }
		}
	})();
	return { get ready() { return ready; }, async close() { controller.abort(); await done; } };
}
