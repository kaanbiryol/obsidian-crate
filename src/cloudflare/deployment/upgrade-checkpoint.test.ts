import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createUpgradeCheckpoint, releaseUpgradeGuards, removeUpgradeGuards, upgradeGuards } from './upgrade-checkpoint';
import { migrationTransaction, SERVER_RELEASE } from './database-upgrades';
import { CloudflareApiClient, CloudflareApiError } from '../cloudflare-api';
import type { HttpTransport } from '../http';
import type { DeploymentFence } from './fence';
import { sha256Hex } from '../../platform/sha256';
import { upgradeBackupStoreKey } from '../../protocol/storage-keys';

const schema = readFileSync('src/cloudflare/schema.sql', 'utf8');
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const openDatabases: DatabaseSync[] = [];
afterEach(() => { openDatabases.splice(0).forEach(db => db.close()); });
function database(sql = schema) { const db = new DatabaseSync(':memory:'); openDatabases.push(db); db.exec(sql); return db; }
interface Manifest { format: number; complete: boolean; createdAt: string; databaseParts: Array<{ sha256: string; size: number }>; objects: Array<{ key: string; sha256: string; size: number; contentType: string }> }

function runQuery(db: DatabaseSync, sql: string, params: string[] = []) {
	if (/^(SELECT|PRAGMA)/.test(sql.trim()) || /\bRETURNING\b/.test(sql)) return db.prepare(sql).all(...params);
	if (params.length) db.prepare(sql).run(...params); else db.exec(sql);
	return [];
}

async function harness() {
	const db = database();
	const live = new TextEncoder().encode('Existing note.'), history = new TextEncoder().encode('Earlier note.');
	db.prepare('INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES (?,?,?,?,?)').run('note.md', 'note.md', await sha256Hex(live), live.length, 'existing-object');
	db.prepare('INSERT INTO file_versions(storage_key,path,hash,size,reason,expires_at) VALUES (?,?,?,?,?,?)').run('historical-object', 'note.md', await sha256Hex(history), history.length, 'replaced', 2_000_000_000);
	db.prepare('INSERT INTO auth_tokens(id,token_hash,scope) VALUES (?,?,?)').run('old-device', 'hashed-secret', 'vault');
	const objects = new Map<string, Uint8Array>([['existing-object', live], ['historical-object', history], ['__crate__/settings.json', new TextEncoder().encode('{"setting":true}')]]);
	const api = {
		queryD1: vi.fn(async (_account: string, _database: string, sql: string, params?: string[]) => [{ results: runQuery(db, sql, params) }]),
		getRecoveryObject: vi.fn(async (_account: string, _bucket: string, key: string) => { const value = objects.get(key); if (!value) throw new CloudflareApiError('Object not found', 404, null); return value; }),
		putRecoveryObject: vi.fn(async (_account: string, _bucket: string, key: string, value: Uint8Array) => { objects.set(key, value); }),
		listR2ObjectSizes: vi.fn(async (_account: string, _bucket: string, _cursor?: string, prefix: string = '') => ({
			objects: [...objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => ({ key, size: value.length })),
		})),
		throttle: vi.fn(async () => undefined),
	};
	const fence = { requireVerification: vi.fn(), mutate: vi.fn(<T>(operation: () => Promise<T>, _step: string) => operation()) };
	const run = (onProgress?: (message: string) => void, client: CloudflareApiClient = api as unknown as CloudflareApiClient) =>
		createUpgradeCheckpoint({ api: client, accountId: 'account', databaseId: 'database', bucketName: 'bucket', fence: fence as unknown as DeploymentFence, onProgress });
	const progress = () => JSON.parse(String((db.prepare("SELECT value FROM maintenance_state WHERE key = 'crate_upgrade_backup'").get() as { value?: string } | undefined)?.value ?? 'null')) as Record<string, unknown> | null;
	const manifestKeys = () => [...objects.keys()].filter(key => key.endsWith('/archive.json'));
	const manifest = () => JSON.parse(decode(objects.get(manifestKeys()[0]!))) as Manifest;
	const prefix = () => manifestKeys()[0]!.slice(0, -'/archive.json'.length);
	/** The restore tools read a format 2 export as its parts in order. */
	const exported = () => manifest().databaseParts.map(part => decode(objects.get(`${prefix()}/objects/${part.sha256}`))).join('');
	const gets = (key: string) => api.getRecoveryObject.mock.calls.filter(([, , requested]) => requested === key).length;
	return { db, objects, api, fence, run, progress, manifest, manifestKeys, prefix, exported, gets, live, history };
}

it('copies files before pausing writers, then exports a paused database that restores independently', async () => {
	const h = await harness();
	const onProgress = vi.fn<(message: string) => void>();
	const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
	try {
		h.api.getRecoveryObject.mockImplementationOnce(async (...args) => {
			// Sync still works while files are copied.
			expect(() => h.db.exec("UPDATE auth_tokens SET device_name = 'Copying'")).not.toThrow();
			expect(h.fence.requireVerification).not.toHaveBeenCalled();
			return h.objects.get(args[2])!;
		});
		await h.run(onProgress);
	} finally { now.mockRestore(); }
	expect(onProgress.mock.calls.map(([message]) => message)).toEqual([
		'Backing up files and history: 0 of 2 checked. Sync continues during this step…',
		'Backing up files and history: 2 of 2 checked. Sync continues during this step…',
		'Backing up the server database. Large servers can take several minutes…',
		'Finishing and verifying the backup archive…',
	]);
	expect(() => h.db.exec('DELETE FROM files')).toThrow('upgrade in progress');
	expect(h.fence.mutate.mock.calls.map(([, step]) => step)).toEqual(['freeze-upgrade-data', 'verify-upgrade-checkpoint']);
	const manifest = h.manifest();
	expect(manifest).toMatchObject({ format: 2, complete: true });
	expect(manifest.databaseParts.map(part => part.sha256)).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
	expect(manifest.objects.map(item => item.key)).toEqual(['__crate__/settings.json', 'existing-object', 'historical-object']);
	for (const item of manifest.objects) expect(await sha256Hex(h.objects.get(upgradeBackupStoreKey(item.sha256))!)).toBe(item.sha256);
	// Three requests per file became two: read the original, write the shared copy.
	expect(h.api.putRecoveryObject.mock.calls.filter(([, , key]) => key.includes('/objects/')).length).toBe(manifest.objects.length + manifest.databaseParts.length);
	expect(h.gets('existing-object')).toBe(1);
	expect(h.db.prepare("SELECT value FROM maintenance_state WHERE key = 'crate_upgrade_checkpoint'").get()).toEqual({ value: h.prefix() });
	const restored = database(h.exported());
	expect(restored.prepare('SELECT scope FROM auth_tokens').get()).toMatchObject({ scope: 'vault' });
	expect(restored.prepare('SELECT device_name FROM auth_tokens').get()).toMatchObject({ device_name: 'Copying' });
	expect(restored.prepare('SELECT storage_key FROM files').get()).toMatchObject({ storage_key: 'existing-object' });

	const sql = 'ALTER TABLE auth_tokens ADD COLUMN example TEXT;';
	const step = { id: 'example', file: 'example.sql', from: SERVER_RELEASE.schemaVersion, to: SERVER_RELEASE.schemaVersion + 1, checksum: await sha256Hex(sql) };
	h.db.exec(`BEGIN; ${removeUpgradeGuards('auth_tokens')} ${await migrationTransaction(step, sql)} ${upgradeGuards('auth_tokens')} COMMIT;`);
	expect(h.db.prepare('SELECT version FROM crate_schema').get()).toMatchObject({ version: step.to });
	// A retried migration reuses the backup taken before it started.
	h.api.putRecoveryObject.mockClear();
	await h.run();
	expect(h.api.putRecoveryObject).not.toHaveBeenCalled();
	expect(h.manifestKeys()).toHaveLength(1);
	await releaseUpgradeGuards(h.api, 'account', 'database', h.fence as unknown as DeploymentFence);
	expect(() => h.db.exec("UPDATE auth_tokens SET device_name='Updated'")).not.toThrow();
	expect(h.progress()).toBeNull();
});

it('resumes copying files without pausing writers or repeating verified copies', async () => {
	const h = await harness();
	const read = h.api.getRecoveryObject.getMockImplementation()!;
	h.api.getRecoveryObject.mockImplementation(async (...args) => {
		if (args[2] === 'historical-object' && h.gets('historical-object') === 1) throw new CloudflareApiError('Unavailable', 503, null);
		return read(...args);
	});
	await expect(h.run()).rejects.toMatchObject({ status: 503 });
	expect(h.progress()).toMatchObject({ format: 2, phase: 'copying' });
	expect(h.fence.requireVerification).not.toHaveBeenCalled();
	expect(h.fence.mutate).not.toHaveBeenCalled();
	expect(() => h.db.exec("UPDATE auth_tokens SET device_name = 'Still syncing'")).not.toThrow();
	const prefix = String(h.progress()!.prefix);
	await h.run();
	expect(h.prefix()).toBe(prefix);
	expect(h.gets('existing-object')).toBe(1);
	expect(h.gets('historical-object')).toBe(2);
});

it('resumes an interrupted export from its saved row while writers stay paused', async () => {
	const h = await harness();
	const receipt = h.db.prepare('INSERT INTO upload_operations(operation_id,request_hash,response_json) VALUES (?,?,?)');
	for (let index = 0; index < 2600; index++) receipt.run(`op-${String(index).padStart(5, '0')}`, `hash-${index}`, JSON.stringify({ padding: 'x'.repeat(3500), index }));
	const write = h.api.putRecoveryObject.getMockImplementation()!;
	let parts = 0;
	h.api.putRecoveryObject.mockImplementation(async (...args) => {
		if (/schema-upgrade-[a-f0-9]{8}-[a-f0-9]{4}-4/.test(args[2]) && args[2].includes('/objects/') && ++parts === 2) throw new Error('Obsidian closed');
		return write(...args);
	});
	await expect(h.run()).rejects.toThrow('Obsidian closed');
	expect(h.progress()).toMatchObject({ phase: 'dumping', after: ['op-01499'] });
	expect(h.progress()!.parts).toHaveLength(1);
	expect(() => h.db.exec('DELETE FROM upload_operations')).toThrow('upgrade in progress');
	h.api.queryD1.mockClear(); h.fence.mutate.mockClear();
	await h.run();
	const resumed = h.api.queryD1.mock.calls.map(([, , sql]) => sql);
	expect(resumed).toContain(`SELECT * FROM "upload_operations" WHERE ("operation_id") > ('op-01499') ORDER BY "operation_id" LIMIT 500;`);
	expect(resumed.some(sql => sql.includes('FROM "auth_tokens"'))).toBe(false);
	expect(h.fence.mutate.mock.calls.map(([, step]) => step)).toEqual(['verify-upgrade-checkpoint']);
	expect(h.manifest().databaseParts).toHaveLength(2);
	const restored = database(h.exported());
	expect(restored.prepare('SELECT COUNT(*) AS n FROM upload_operations').get()).toEqual({ n: 2600 });
	expect(restored.prepare('SELECT * FROM upload_operations ORDER BY 1').all()).toEqual(h.db.prepare('SELECT * FROM upload_operations ORDER BY 1').all());
});

it('restarts a saved export after its write guards were removed', async () => {
	const h = await harness();
	const write = h.api.putRecoveryObject.getMockImplementation()!;
	let manifests = 0;
	h.api.putRecoveryObject.mockImplementation(async (...args) => {
		if (args[2].endsWith('/archive.json') && ++manifests === 1) throw new Error('Interrupted');
		return write(...args);
	});
	await expect(h.run()).rejects.toThrow('Interrupted');
	expect(h.progress()).toMatchObject({ phase: 'finishing' });
	for (const row of h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) h.db.exec(`DROP TRIGGER "${String(row.name)}"`);
	h.db.exec("INSERT INTO reminder_identities(reminder_id,created_operation_id) VALUES ('written-later','operation')");
	await h.run();
	expect(h.fence.mutate.mock.calls.map(([, step]) => step)).toEqual(['freeze-upgrade-data', 'freeze-upgrade-data', 'verify-upgrade-checkpoint']);
	expect(database(h.exported()).prepare('SELECT reminder_id FROM reminder_identities').all()).toEqual([{ reminder_id: 'written-later' }]);
});

it('finishes after a lost manifest write without copying files again', async () => {
	const h = await harness();
	const write = h.api.putRecoveryObject.getMockImplementation()!;
	let manifests = 0;
	h.api.putRecoveryObject.mockImplementation(async (...args) => {
		await write(...args);
		if (args[2].endsWith('/archive.json') && ++manifests === 1) throw new Error('Lost response');
	});
	await expect(h.run()).rejects.toThrow('Lost response');
	const copies = h.api.putRecoveryObject.mock.calls.length;
	await h.run();
	expect(h.api.putRecoveryObject.mock.calls.slice(copies).map(([, , key]) => key)).toEqual([`${h.prefix()}/archive.json`]);
	expect(h.gets('existing-object')).toBe(1);
	expect(h.progress()).toMatchObject({ phase: 'complete' });
});

it('rejects changed source bytes before pausing writers', async () => {
	const h = await harness();
	h.objects.set('existing-object', new TextEncoder().encode('Changed!'));
	await expect(h.run()).rejects.toThrow('could not be verified');
	expect(h.fence.mutate).not.toHaveBeenCalled();
	expect(h.manifestKeys()).toEqual([]);
});

it('waits for Cloudflare rate limits through the real API client and completes', async () => {
	const h = await harness();
	let requests = 0;
	const json = (result: unknown) => ({ status: 200, text: JSON.stringify({ success: true, result, result_info: { is_truncated: false } }) });
	const transport: HttpTransport = async (url, request) => {
		if (++requests % 4 === 0) return { status: 429, text: JSON.stringify({ success: false, errors: [{ code: 971, message: 'Please wait' }] }), headers: { 'Retry-After': '7' } };
		const { pathname, searchParams } = new URL(url);
		if (pathname.endsWith('/query')) {
			const body = JSON.parse(request.body as string) as { sql: string; params?: string[] };
			return json([{ success: true, results: runQuery(h.db, body.sql, body.params) }]);
		}
		const [, encoded] = /\/r2\/buckets\/bucket\/objects(?:\/(.+))?$/.exec(pathname)!;
		if (!encoded) return json([...h.objects].filter(([key]) => key.startsWith(searchParams.get('prefix') ?? '')).map(([key, value]) => ({ key, size: value.length })));
		const key = encoded.split('/').map(decodeURIComponent).join('/');
		if (request.method === 'PUT') { h.objects.set(key, new Uint8Array(request.body as ArrayBuffer)); return json({}); }
		const value = h.objects.get(key);
		return value ? { status: 200, text: '', arrayBuffer: value.slice().buffer } : { status: 404, text: '' };
	};
	const sleep = vi.fn(async (_milliseconds: number) => undefined);
	const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
	try { await h.run(undefined, new CloudflareApiClient('token', transport, { sleep })); }
	finally { now.mockRestore(); }
	expect(h.manifest()).toMatchObject({ format: 2, complete: true });
	expect(requests).toBeGreaterThan(20);
	expect(sleep.mock.calls.filter(([milliseconds]) => milliseconds === 7_000).length).toBe(Math.floor(requests / 4));
	// Bulk requests are paced 300 ms apart.
	expect(sleep.mock.calls.filter(([milliseconds]) => milliseconds !== 7_000).every(([milliseconds]) => milliseconds % 300 === 0)).toBe(true);
	expect(database(h.exported()).prepare('SELECT storage_key FROM file_versions').get()).toEqual({ storage_key: 'historical-object' });
});

it('pages large tables by key so each row is read once', async () => {
	const h = await harness();
	const receipt = h.db.prepare('INSERT INTO upload_operations(operation_id,request_hash,response_json) VALUES (?,?,?)');
	for (let index = 0; index < 1234; index++) receipt.run(`op-${String(index).padStart(5, '0')}`, `hash-${index}`, `{"index":${index}}`);
	const identity = h.db.prepare('INSERT INTO reminder_identities(reminder_id,created_operation_id) VALUES (?,?)');
	for (let index = 0; index < 1001; index++) identity.run(`reminder-${index}`, 'operation');
	await h.run();
	const pages = h.api.queryD1.mock.calls.map(([, , sql]) => sql).filter(sql => /FROM "(upload_operations|reminder_identities)"/.test(sql));
	expect(h.api.queryD1.mock.calls.some(([, , sql]) => /\bOFFSET\b/i.test(sql))).toBe(false);
	for (const [table, count] of [['upload_operations', 1234], ['reminder_identities', 1001]] as const) {
		const tablePages = pages.filter(sql => sql.includes(`FROM "${table}"`));
		expect(tablePages.reduce((sum, sql) => sum + h.db.prepare(sql).all().length, 0)).toBe(count);
		expect(tablePages).toHaveLength(Math.floor(count / 500) + 1);
		for (const sql of tablePages.slice(1)) {
			expect(sql).toContain(' WHERE ');
			const plan = h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => String(row.detail)).join('\n');
			expect(plan).toMatch(/^SEARCH /m);
		}
	}
	const restored = database(h.exported());
	for (const table of ['upload_operations', 'reminder_identities']) {
		expect(restored.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(h.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
	}
});
