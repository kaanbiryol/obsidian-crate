import { CloudflareApiError } from './cloudflare-api';

/** Drain dispatched requests on failure, without starting more work. */
export async function deleteObjectGroup(keys: string[], remove: (key: string) => Promise<void>, onDeleted: () => void, onThrottled: () => void): Promise<void> {
	let next = 0;
	let pausedUntil = 0;
	const failures: unknown[] = [];
	const run = async () => {
		while (!failures.length && next < keys.length) {
			const key = keys[next++]!;
			try {
				for (let attempt = 0; ; attempt++) {
					while (!failures.length && pausedUntil > Date.now()) {
						await new Promise(resolve => window.setTimeout(resolve, pausedUntil - Date.now()));
					}
					if (failures.length) return;
					try {
						await remove(key);
						onDeleted();
						break;
					} catch (error) {
						// Only retry explicit throttling: lost responses retain the fence.
						if (!(error instanceof CloudflareApiError) || error.status !== 429 || attempt === 3) throw error;
						pausedUntil = Math.max(pausedUntil, Date.now() + 1000 * 2 ** attempt);
						onThrottled();
					}
				}
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(10, keys.length) }, run));
	if (failures.length === 1) throw failures[0];
	if (failures.length && failures.every(error => error instanceof Error && error.name === 'AbortError')) throw failures[0];
	// Mixed definite and uncertain failures must retain the deployment fence.
	if (failures.length > 1) throw new Error(`Remote file deletion failed: ${failures.map(String).join('; ')}`);
}
