import type { ResetApi } from './reset-ownership';

// Include orphaned uploads with Crate's generated key format, retained versions,
// shared settings, and legacy keys explicitly referenced by Crate's database.
const MANAGED_OBJECT = /^__crate__\/files\/[a-f0-9]{64}\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export async function createObjectOwnershipCheck(api: ResetApi, accountId: string, databaseId: string, tables: string[]): Promise<(key: string) => Promise<void>> {
	const sources: Array<{ table: string; column: string }> = [];
	for (const table of ['files', 'file_versions', 'object_cleanup_queue']) {
		if (!tables.includes(table)) continue;
		const columns = (await api.queryD1(accountId, databaseId, `PRAGMA table_info(${table});`))
			.flatMap(result => result.results ?? []).map(row => row.name);
		if (columns.includes('storage_key')) sources.push({ table, column: 'storage_key' });
		else if (table === 'files' && columns.includes('path')) sources.push({ table, column: 'path' });
		else throw new Error('Reset blocked: could not verify Crate file references.');
	}
	return async key => {
		if (key.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Reset blocked: unsafe R2 object key.');
		if (MANAGED_OBJECT.test(key) || key === '__crate__/settings.json') return;
		for (const source of sources) {
			const rows = await api.queryD1(accountId, databaseId,
				`SELECT 1 AS found FROM ${source.table} WHERE ${source.column} = ? LIMIT 1;`, [key]);
			if (rows.some(result => result.results?.some(row => row.found === 1))) return;
		}
		throw new Error(`Reset blocked: the bucket contains an object not identified as Crate data: ${key}`);
	};
}

export async function inspectBucketObjects(api: ResetApi, accountId: string, bucketName: string, check: (key: string) => Promise<void>, onProgress?: (message: string) => void): Promise<void> {
	let checked = 0;
	onProgress?.('Checking remote files: 0 checked…');
	let cursor: string | undefined;
	const seen = new Set<string>();
	do {
		const page = await api.listR2Objects(accountId, bucketName, cursor);
		for (const key of page.keys) {
			await check(key);
			checked++;
			if (checked === 1 || checked % 10 === 0) onProgress?.(`Checking remote files: ${checked.toLocaleString()} checked…`);
		}
		onProgress?.(`Checking remote files: ${checked.toLocaleString()} checked…`);
		cursor = page.cursor;
		if (cursor && seen.has(cursor)) throw new Error('Reset blocked: R2 pagination did not advance.');
		if (cursor) seen.add(cursor);
	} while (cursor);
}

export async function clearBucketObjects(api: ResetApi, accountId: string, bucketName: string, check: (key: string) => Promise<void>, verifyTarget: () => Promise<void>, onProgress?: (message: string) => void): Promise<void> {
	// Restart at the beginning after each deletion batch so changing pagination
	// cannot skip objects. A failed request leaves the reset checkpoint resumable.
	let deleted = 0;
	onProgress?.('Removing remote files: 0 deleted…');
	let previousFirst: string | undefined;
	for (;;) {
		await verifyTarget();
		const page = await api.listR2Objects(accountId, bucketName);
		if (page.keys.length === 0) {
			if (page.cursor) throw new Error('Reset paused: R2 returned an incomplete empty page.');
			return;
		}
		if (previousFirst === page.keys[0]) throw new Error('Reset paused: R2 deletion did not advance.');
		previousFirst = page.keys[0];
		for (const key of page.keys) await check(key);
		for (const key of page.keys) {
			await api.deleteR2Object(accountId, bucketName, key);
			deleted++;
			if (deleted === 1 || deleted % 10 === 0) onProgress?.(`Removing remote files: ${deleted.toLocaleString()} deleted…`);
		}
		onProgress?.(`Removing remote files: ${deleted.toLocaleString()} deleted…`);
	}
}
