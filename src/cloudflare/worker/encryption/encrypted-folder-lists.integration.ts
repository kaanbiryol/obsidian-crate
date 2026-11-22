/// <reference types="@cloudflare/vitest-plugin/types" />
import { MAX_BATCH_DOWNLOAD_FILES } from '../sync/storage';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { installStorageCostMeter } from '../test-support/storage-cost-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import worker from '../index';
import { handleEncryptedFolderFiles } from './encrypted-folder-files';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sealFile } from '@/encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '@/encryption/file-format';
import { createReminderProjection } from '@/reminders/core/encrypted-schedule-projection';
import { sealFolderLabel } from '@/encryption/folder-label';
import { importEncryptionSecret } from '@/encryption/envelope';
import { importNotificationFingerprintKey } from '@/encryption/notification-keys';
import { importSealPrivateKey } from '@/encryption/seal-key';
import { derivePathTagKey, PathTags } from '@/encryption/path-tags';
import { EncryptedReminderApi } from '@/pwa/reminders/encrypted-reminder-api';

// Rows, queries and requests of encrypted folder lists, through the real Worker, D1 and R2.
beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

const op = () => createReminderOperationId(Math.floor(Date.now() / 86_400_000));
const b64 = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
const reminderNote = (n: number) => `# Tasks\n\n${Array.from({ length: 10 }, (_, i) =>
	`- [ ] Note ${n} task ${i}${i === 0 ? ' 2099-01-01T09:00:00.000Z' : ''} <!-- crate-id:${crypto.randomUUID()} -->`).join('\n')}\n`;

async function setup() {
	const fx = await createEncryptionFixture('active');
	await storeEncryptionState(env.DB, fx.state);
	const vaultKey = await importEncryptionSecret(fx.bundle.vault);
	const reminders = await sealFolderLabel('Reminders', fx.paths, vaultKey, fx.bundle.vaultId);
	const reading = await sealFolderLabel('Reading', fx.paths, vaultKey, fx.bundle.vaultId);
	const wire = reminders.wire;
	await env.DB.batch([
		env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind(`e2ee:folder:${wire}`, reminders.label),
		env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind(`e2ee:folder:${reading.wire}`, reading.label),
		env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, ?, 'UTC', 'policy')").bind(wire),
		env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,?,'policy','revision')").bind(reading.wire),
		env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, last_seen_at) VALUES ('vault', ?, 'vault', datetime('now'))").bind(await sha256Hex('vault-credential')),
		env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path, last_seen_at) VALUES ('web', ?, 'reminders', ?, datetime('now'))").bind(await sha256Hex('web-session'), wire),
		env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path, reading_generation, last_seen_at) VALUES ('reader', ?, 'reminders', ?, 'policy', datetime('now'))").bind(await sha256Hex('reader-token'), reading.wire),
	]);
	const requests: string[] = [];
	const send = (path: string, { token = 'web-session', ...init }: RequestInit & { token?: string } = {}) => {
		requests.push(`${init.method ?? 'GET'} ${path.split('?')[0]}`);
		return worker.fetch(new Request(`https://crate.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}`,
			[CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), 'Content-Type': 'application/json',
			'X-Crate-Encryption-Vault': fx.state.vaultId, 'X-Crate-Encryption-Generation': String(fx.state.generation), ...init.headers } }), env);
	};
	const inventory = (query = '', headers: Record<string, string> = {}) => send(`/reminders/encrypted-files?folderPath=${encodeURIComponent(wire)}${query}`, { headers });
	const seal = async (plain: string, text: string) => {
		const bytes = new TextEncoder().encode(text);
		const sealed = await sealFile({ path: plain, content: bytes, 
			publicData: await createReminderProjection(fx.notifications, ['Reminders'], plain, bytes.buffer) }, fx.keys.forPath(await fx.paths.wire(plain)));
		return { wire: await fx.paths.wire(plain), sealed };
	};
	/** Sealed reminder notes uploaded the way Obsidian uploads them. */
	const upload = async (notes: Array<Awaited<ReturnType<typeof seal>>>, previous = new Map<string, { hash: string; revision: string }>()) => {
		for (let i = 0; i < notes.length; i += 25) {
			const files = notes.slice(i, i + 25).map(({ wire: path, sealed }) => ({ path, content: b64(sealed.bytes), expectedHash: previous.get(path)?.hash ?? null,
				...(previous.has(path) ? { expectedRevision: previous.get(path)!.revision } : {}), operationId: op(), contentType: ENCRYPTED_FILE_CONTENT_TYPE }));
			const response = await send('/sync/batch-upload', { method: 'POST', token: 'vault-credential', body: JSON.stringify({ files }) });
			if (response.status !== 200) throw new Error(`upload ${response.status} ${await response.text()}`);
		}
	};
	/** `count` inventory rows written straight to D1: list costs depend on rows, not contents. */
	const seedRows = async (count: number) => {
		await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
			INSERT INTO files(path, portable_path, hash, size, storage_key) SELECT ? || '/' || printf('%026d', x) || '.md', ? || '/' || printf('%026d', x) || '.md', printf('%064d', x), 100, 'key-' || x FROM n`)
			.bind(count, wire, wire).run();
		await env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) SELECT path, 'put', hash, size, storage_key FROM files").run();
	};
	const api = async () => {
		const pathTag = await derivePathTagKey(fx.bundle.vaultId, fx.bundle.vault);
		const keys = { version: 1 as const, vaultId: fx.bundle.vaultId, generation: fx.bundle.generation, folderPath: 'Reminders', wireFolder: wire, paths: new PathTags(pathTag), pathTag, readingSearch: pathTag,
			vault: vaultKey, notifications: await importEncryptionSecret(fx.bundle.notifications),
			notificationFingerprint: await importNotificationFingerprintKey(fx.bundle.vaultId, fx.bundle.notifications),
			seal: { keyId: fx.bundle.seal.id, publicKey: fx.bundle.seal.publicKey, privateKey: await importSealPrivateKey(fx.bundle.seal) }, localState: 'unused' };
		const indexes = new Map<string, unknown>();
		const store = { loadAttempt: async () => undefined, saveAttempt: async () => undefined, pruneAttempts: async (_s: unknown, _d: number, _c: unknown, after?: string) => after,
			loadIndex: async (scope: string) => indexes.get(scope), saveIndex: async (scope: string, _identity: string, notes: unknown) => { indexes.set(scope, notes); } };
		return new EncryptedReminderApi(keys, (path, init) => send(path, init), { store: store as never, current: () => true });
	};
	return { fx, wire, reading: reading.wire, send, requests, inventory, seal, upload, seedRows, api };
}
const page = async (response: Response) => response.json() as Promise<{ files: Array<{ path: string; hash: string; revision: string }>; removed?: string[]; delta?: true;
	nextCursor?: string | null; changeToken: string; deltaBase: string }>;

async function measure<T>(action: () => Promise<T>) {
	const meter = await installStorageCostMeter();
	try { return await meter.measure(action, { alarms: false }); } finally { await meter.restore(); }
}

it.each([100, 1000])('answers an unchanged poll of %i notes with a 304 that reads no folder rows', async count => {
	const h = await setup();
	await h.seedRows(count);
	const full = await measure(() => h.inventory());
	const first = await page(full.result);
	expect(first.files).toHaveLength(count);
	const poll = await measure(() => h.inventory('', { 'If-None-Match': `"${first.changeToken}"` }));
	expect(poll.result.status).toBe(304);
	expect(poll.result.headers.get('ETag')).toBe(`"${first.changeToken}"`);
	console.info(`ENCRYPTED_POLL notes=${count} full: q=${full.cost.queries} read=${full.cost.rowsRead} | 304: q=${poll.cost.queries} read=${poll.cost.rowsRead}`);
	// Before: every poll read the first inventory page, about one row per note.
	expect(full.cost.rowsRead).toBeGreaterThan(count);
	expect(poll.cost.rowsRead).toBeLessThanOrEqual(12);
	expect(poll.cost.queries).toBeLessThanOrEqual(3);
});

async function changeNotes(edit: string, remove: string) {
	await env.DB.batch([
		env.DB.prepare("UPDATE files SET storage_key = 'edited', hash = ? WHERE path = ?").bind('e'.repeat(64), edit),
		env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES (?, 'put', ?, 100, 'edited')").bind(edit, 'e'.repeat(64)),
		env.DB.prepare('DELETE FROM files WHERE path = ?').bind(remove),
		env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES (?, 'delete', '', 0, NULL)").bind(remove),
		// Outside the folder: the token changes, the folder does not.
		env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES ('Other/note.md', 'put', 'x', 1, 'x')"),
	]);
}

it('returns only the folder notes changed since a delta base', async () => {
	const h = await setup();
	await h.seedRows(1000);
	const first = await page(await h.inventory());
	const [edit, remove] = [first.files[10]!.path, first.files[20]!.path];
	await changeNotes(edit, remove);
	const delta = await measure(() => h.inventory(`&since=${encodeURIComponent(first.deltaBase)}`, { 'If-None-Match': `"${first.changeToken}"` }));
	const body = await page(delta.result);
	expect(body).toMatchObject({ delta: true, files: [{ path: edit, revision: 'edited' }], removed: [remove] });
	expect(body.changeToken).not.toBe(first.changeToken);
	console.info(`ENCRYPTED_DELTA notes=1000 changes=2: q=${delta.cost.queries} read=${delta.cost.rowsRead}`);
	expect(delta.cost.rowsRead).toBeLessThanOrEqual(30);

	// A change elsewhere in the vault lists nothing and reads no file rows.
	await env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES ('Other/second.md', 'put', 'x', 1, 'x')").run();
	const elsewhere = await measure(() => h.inventory(`&since=${encodeURIComponent(body.deltaBase)}`, { 'If-None-Match': `"${body.changeToken}"` }));
	expect(await page(elsewhere.result)).toMatchObject({ delta: true, files: [], removed: [] });
	console.info(`ENCRYPTED_DELTA_ELSEWHERE notes=1000: q=${elsewhere.cost.queries} read=${elsewhere.cost.rowsRead}`);
	expect(elsewhere.cost.rowsRead).toBeLessThanOrEqual(15);
});

it('lists the whole folder when the delta base belongs to another view or was pruned', async () => {
	const h = await setup();
	await h.seedRows(3);
	const first = await page(await h.inventory());
	await env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES ('Other/note.md', 'put', 'x', 1, 'x')").run();
	const [seq] = first.deltaBase.split('.');
	for (const since of [`${seq}.${'0'.repeat(32)}`, 'garbage']) {
		const body = await page(await h.inventory(`&since=${encodeURIComponent(since)}`));
		expect(body.delta).toBeUndefined();
		expect(body.files).toHaveLength(3);
	}
	await env.DB.prepare('DELETE FROM changelog WHERE seq <= ?').bind(Number(seq)).run();
	await env.DB.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES ('Other/again.md', 'put', 'x', 1, 'x')").run();
	await env.DB.prepare('DELETE FROM changelog WHERE path = ?').bind('Other/note.md').run();
	expect((await page(await h.inventory(`&since=${encodeURIComponent(first.deltaBase)}`))).files).toHaveLength(3);
});

it('refuses a listing that a concurrent write would split across snapshots', async () => {
	const h = await setup();
	await h.seedRows(3);
	const db = new Proxy(env.DB, { get: (target, key) => key === 'prepare' ? (sql: string) => {
		const statement = target.prepare(sql);
		if (!sql.includes('ORDER BY portable_path LIMIT')) return statement;
		return new Proxy(statement, { get: (s, k) => k === 'bind' ? (...args: unknown[]) => {
			const bound = s.bind(...args);
			return new Proxy(bound, { get: (b, method) => method === 'all' ? async () => {
				const result = await b.all();
				await target.prepare("INSERT INTO changelog(path, action, hash, size, revision) VALUES ('Other/race.md', 'put', 'x', 1, 'x')").run();
				return result;
			} : Reflect.get(b, method, b) as unknown });
		} : Reflect.get(s, k, s) as unknown });
	} : Reflect.get(target, key, target) as unknown });
	const response = await handleEncryptedFolderFiles(new Request(`https://test/reminders/encrypted-files?folderPath=${h.wire}`), { ...env, DB: db }, '/reminders/encrypted-files');
	expect(response!.status).toBe(409);
	expect(await response!.json()).toMatchObject({ code: 'inventory_changed' });
});

it('downloads listed notes at their revisions and reports each changed or missing one', async () => {
	const h = await setup();
	const notes = await Promise.all([0, 1].map(n => h.seal(`Reminders/Note ${n}.md`, reminderNote(n))));
	await h.upload(notes);
	const listed = await page(await h.inventory());
	const [kept, stale] = notes.map(note => listed.files.find(file => file.path === note.wire)!);
	const missing = await h.fx.paths.wire('Reminders/Missing.md');
	const download = (files: unknown[], token?: string, prefix = '/reminders', folderPath = h.wire) =>
		h.send(`${prefix}/encrypted-files/download`, { method: 'POST', token, body: JSON.stringify({ folderPath, files }) });
	const measured = await measure(() => download([{ path: kept!.path, revision: kept!.revision }, { path: stale!.path, revision: 'older' }, { path: missing, revision: 'any' }]));
	const { files } = await measured.result.json() as { files: Array<Record<string, unknown>> };
	expect(files.map(file => file.code ?? 'ok')).toEqual(['ok', 'version_conflict', 'not_found']);
	expect(await sha256Hex(new TextEncoder().encode(files[0]!.content as string))).toBe(kept!.hash);
	expect(files[0]).toMatchObject({ path: kept!.path, revision: kept!.revision, size: notes[0]!.sealed.bytes.length });
	expect(measured.cost.r2.get).toBe(1);

	expect((await download(Array.from({ length: MAX_BATCH_DOWNLOAD_FILES + 1 }, (_, i) => ({ path: `${h.wire}/${i}.md`, revision: 'r' })))).status).toBe(400);
	expect((await download([{ path: kept!.path, revision: 'r' }, { path: kept!.path, revision: 'r' }])).status).toBe(400);
	expect((await download([{ path: 'Elsewhere/note.md', revision: 'r' }])).status).toBe(403);
	expect((await download([{ path: kept!.path, revision: 'r' }], undefined, '/reminders', h.reading)).status).toBe(403);
	// Reading serves the same route for its own folder only.
	const readingNote = `${h.reading}/${'a'.repeat(26)}.md`;
	const readingAnswer = await download([{ path: readingNote, revision: 'r' }], 'reader-token', '/reading', h.reading);
	expect(await readingAnswer.json()).toEqual({ files: [{ path: readingNote, revision: 'r', error: 'Note not found', code: 'not_found' }] });
	expect((await download([{ path: kept!.path, revision: kept!.revision }], 'reader-token', '/reading')).status).toBe(403);
});

it('lists a cold folder of 100 notes in three requests, and an unchanged one in one', async () => {
	const h = await setup();
	const notes = await Promise.all(Array.from({ length: 100 }, (_, n) => h.seal(`Reminders/Note ${n}.md`, reminderNote(n))));
	await h.upload(notes);
	const api = await h.api();
	const list = (etag?: string) => api.handle('/reminders/list?folderPath=Reminders', etag ? { headers: { 'If-None-Match': etag } } : {});
	h.requests.length = 0;
	const cold = await measure(() => list());
	const body = await cold.result!.json() as { reminders: unknown[]; issues: unknown[] };
	expect(body.reminders).toHaveLength(1000);
	expect(body.issues).toEqual([]);
	expect(h.requests).toEqual(['GET /reminders/encrypted-files', 'POST /reminders/encrypted-files/download', 'POST /reminders/encrypted-files/download']);
	console.info(`ENCRYPTED_COLD notes=100: requests=${h.requests.length} q=${cold.cost.queries} read=${cold.cost.rowsRead} r2=${cold.cost.r2.get}`);
	// Before: 102 requests and 206 queries.
	expect(cold.cost.queries).toBeLessThanOrEqual(15);
	expect(cold.cost.r2.get).toBe(100);

	h.requests.length = 0;
	const etag = cold.result!.headers.get('ETag')!;
	const unchanged = await measure(() => list(etag));
	expect(unchanged.result!.status).toBe(304);
	expect(h.requests).toEqual(['GET /reminders/encrypted-files']);
	console.info(`ENCRYPTED_UNCHANGED notes=100: requests=${h.requests.length} q=${unchanged.cost.queries} read=${unchanged.cost.rowsRead}`);
	expect(unchanged.cost.rowsRead).toBeLessThanOrEqual(12);

	const current = new Map((await page(await h.inventory())).files.map(file => [file.path, { hash: file.hash, revision: file.revision }]));
	await h.upload([await h.seal('Reminders/Note 3.md', reminderNote(3))], current);
	h.requests.length = 0;
	const changed = await measure(() => list(etag));
	expect(changed.result!.status).toBe(200);
	expect(h.requests).toEqual(['GET /reminders/encrypted-files', 'POST /reminders/encrypted-files/download']);
	console.info(`ENCRYPTED_ONE_CHANGED notes=100: requests=${h.requests.length} q=${changed.cost.queries} read=${changed.cost.rowsRead} r2=${changed.cost.r2.get}`);
	expect(changed.cost.r2.get).toBe(1);
}, 120_000);
