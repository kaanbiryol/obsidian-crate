import type { CloudflareApiClient } from '../cloudflare-api';

export async function clearBucketObjects(api: Pick<CloudflareApiClient, 'listR2Objects'>, accountId: string, bucketName: string, verifyTarget: () => Promise<void>, remove: (keys: string[]) => Promise<void>, onProgress?: (message: string) => void): Promise<void> {
	// Restart at the beginning after each deletion batch so changing pagination
	// cannot skip objects. A failed request leaves the deletion checkpoint resumable.
	let deleted = 0;
	const report = () => onProgress?.(`Removing remote files: ${deleted.toLocaleString()} deleted…`);
	report();
	let previousFirst: string | undefined;
	for (;;) {
		await verifyTarget();
		const page = await api.listR2Objects(accountId, bucketName);
		if (page.keys.length === 0) {
			if (page.cursor) throw new Error('Deletion paused: R2 returned an incomplete empty page.');
			return;
		}
		if (previousFirst === page.keys[0]) throw new Error('Deletion paused: R2 deletion did not advance.');
		previousFirst = page.keys[0];
		for (let offset = 0; offset < page.keys.length;) {
			const keys: string[] = [];
			let bytes = 2;
			while (offset < page.keys.length && keys.length < 1000) {
				const key = page.keys[offset]!;
				const nextBytes = new TextEncoder().encode(JSON.stringify(key)).length + (keys.length ? 1 : 0);
				if (keys.length && bytes + nextBytes > 1_100_000) break;
				keys.push(key); bytes += nextBytes; offset++;
			}
			await remove(keys);
			// Count only a verified bulk response; re-list after an uncertain result.
			deleted += keys.length;
			report();
		}
	}
}
