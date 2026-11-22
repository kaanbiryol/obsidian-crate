/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { SyncRuntime } from '../../../sync/runtime/runtime';
import type { SyncEngine } from '../../../sync/engine/engine';
import type { SyncHistoryEntry } from '../../../sync/types';
import { CHECKPOINT_PAGE_SIZE, checkpointId, createSharedCheckpoint, getSharedCheckpoint, pruneSharedCheckpoints } from './history-checkpoints';
import { parseSharedCheckpointDocument, SELF_HOSTED_SHARED_CHECKPOINTS, type SharedCheckpoint } from '../../../protocol/history-checkpoints';
import { DAY_MS } from '../../../protocol/history-retention';
import { expireFileVersions } from '../maintenance/object-cleanup';
import { LAST_SEQ_SQL } from './storage';
import worker from '../index';
import { sha256Hex } from '../../../platform/sha256';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
});
afterEach(async () => {
	for (const client of clients.splice(0)) { client.close(); await client.engine.waitForIdle(); }
	vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});
async function sync(client: SyncTestDevice) {
	const result = await client.engine.sync();
	expect(result.errors).toEqual([]);
	expect(result.conflicts).toEqual([]);
	expect(result.success).toBe(true);
}

/** Saves the vault as it is now, as a client that saves checkpoints itself would. */
async function saveCheckpoint(): Promise<SharedCheckpoint> {
	const response = await createSharedCheckpoint(env.DB);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json() as { checkpoint: SharedCheckpoint }).checkpoint;
}

/** Ages every checkpoint past the interval, so the next commit saves one. */
const ageCheckpoints = (ms = 11 * 60_000) => env.DB.prepare('UPDATE history_checkpoints SET created_at = created_at - ?').bind(ms).run();

function historyRuntime(device: SyncTestDevice, checkpoint: string): SyncRuntime {
	const entry: SyncHistoryEntry = { timestamp: new Date().toISOString(), type: 'sync', success: true,
		uploaded: 1, downloaded: 0, merged: 0, deleted: 0, conflictCount: 0, errorCount: 0, sharedCheckpoint: checkpoint };
	device.settings.syncHistory.push(entry);
	const runtime = new SyncRuntime({} as never, device.settings, { get: () => null, has: () => false } as never, async update => { Object.assign(device.settings, update); });
	(runtime as unknown as { syncEngine: SyncEngine }).syncEngine = device.engine;
	return runtime;
}

it('restores a full checkpoint through real sync and converges another device', async () => {
	const first = new SyncTestDevice('restore-first', env), second = new SyncTestDevice('restore-second', env);
	clients.push(first, second);
	for (const client of clients) { await client.authorize(); await client.open(); }
	first.disk.write('edited.md', 'before edit\n');
	first.disk.write('deleted.md', 'before deletion\n');
	first.disk.write('original.md', 'before rename\n');
	await sync(first);
	const checkpoint = (await saveCheckpoint()).id;
	await sync(second);
	first.disk.write('edited.md', 'after edit\n');
	first.disk.remove('deleted.md');
	first.disk.rename('original.md', 'renamed.md');
	first.disk.write('added.md', 'after checkpoint\n');
	await sync(first); await sync(second);
	const runtime = historyRuntime(first, checkpoint);
	const review = await runtime.createHistoryRestore(first.settings.syncHistory[0]!);
	expect(review.items).toHaveLength(5);
	await review.restore();
	await sync(second);
	for (const client of clients) {
		expect(client.disk.paths()).toEqual(['deleted.md', 'edited.md', 'original.md']);
		expect(client.disk.text('edited.md')).toBe('before edit\n');
		expect(client.disk.text('deleted.md')).toBe('before deletion\n');
		expect(client.disk.text('original.md')).toBe('before rename\n');
	}
	expect(Object.keys((await first.api.getManifest()).files).sort()).toEqual(['deleted.md', 'edited.md', 'original.md']);
});

it('restores a historical file after that path became a directory', async () => {
	const device = new SyncTestDevice('restore-namespace', env);
	clients.push(device); await device.authorize(); await device.open();
	device.disk.write('note.md', 'original file');
	await sync(device);
	const checkpoint = (await saveCheckpoint()).id;
	device.disk.remove('note.md');
	await sync(device);
	await device.disk.vault.createFolder('note.md');
	device.disk.write('note.md/child.md', 'later file in directory');
	await sync(device);
	const runtime = historyRuntime(device, checkpoint);
	await (await runtime.createHistoryRestore(device.settings.syncHistory[0]!)).restore();
	expect(device.disk.paths()).toEqual(['note.md']);
	expect(device.disk.text('note.md')).toBe('original file');
	expect(Object.keys((await device.api.getManifest()).files)).toEqual(['note.md']);
});

it('saves a checkpoint of the state before a commit once the latest is ten minutes old, and another device rolls back to it', async () => {
	const first = new SyncTestDevice('shared-first', env), second = new SyncTestDevice('shared-second', env);
	clients.push(first, second);
	for (const device of clients) { await device.authorize(); await device.open(); }
	first.disk.write('edited.md', 'original'); first.disk.write('deleted.md', 'bring back');
	await sync(first);
	first.disk.write('edited.md', 'later edit'); first.disk.remove('deleted.md'); first.disk.write('added.md', 'later addition');
	await sync(first);
	const [checkpoint] = await second.api.sharedHistory.list();
	expect(await second.api.sharedHistory.list()).toHaveLength(1);
	expect(checkpoint!.fileCount).toBe(2);
	expect(second.settings.syncHistory).toEqual([]);
	// Edits within ten minutes of it save no other checkpoint.
	first.disk.write('edited.md', 'third edit'); await sync(first);
	expect(await second.api.sharedHistory.list()).toHaveLength(1);
	await ageCheckpoints();
	first.disk.write('edited.md', 'fourth edit'); await sync(first);
	expect(await second.api.sharedHistory.list()).toHaveLength(2);
	await sync(second);
	const runtime = historyRuntime(second, checkpoint!.id);
	await (await runtime.createHistoryRestore(second.settings.syncHistory[0]!)).restore();
	await sync(first);
	for (const device of clients) {
		expect(device.disk.paths()).toEqual(['deleted.md', 'edited.md']);
		expect(device.disk.text('edited.md')).toBe('original');
		expect(device.disk.text('deleted.md')).toBe('bring back');
	}
});

it('downloads retained checkpoint attachments larger than the file-preview limit', async () => {
	const device = new SyncTestDevice('shared-binary', env); clients.push(device);
	await device.authorize(); await device.open();
	const original = new Uint8Array(300_000).fill(42).buffer;
	device.disk.write('attachment.bin', original); await sync(device);
	const checkpoint = await saveCheckpoint();
	device.disk.write('attachment.bin', new Uint8Array(300_000).fill(43).buffer); await sync(device);
	const document = await device.api.sharedHistory.load(checkpoint.id);
	expect(await device.api.sharedHistory.download(checkpoint.id, 'attachment.bin', document.files['attachment.bin']!)).toEqual(original);
});

it('reuses an unchanged state and loads a document once for a comparison and its restore', async () => {
	const device = new SyncTestDevice('shared-race', env); clients.push(device);
	await device.authorize(); await device.open(); device.disk.write('note.md', 'one'); await sync(device);
	const [one, two] = await Promise.all([saveCheckpoint(), saveCheckpoint()]);
	expect(one.id).toBe(two.id);
	expect((await saveCheckpoint()).id).toBe(one.id);
	expect(await device.api.sharedHistory.list()).toHaveLength(1);
	const first = await device.api.sharedHistory.load(one.id);
	const second = await device.api.sharedHistory.load(one.id);
	expect(second.files).toEqual(first.files);
	expect(device.requests.filter(request => request === 'GET /sync/checkpoint')).toHaveLength(1);
});

it('expires checkpoints with the history period and refuses reads by a stale client', async () => {
	const device = new SyncTestDevice('shared-expiry', env); clients.push(device);
	await device.authorize(); await device.open(); device.disk.write('note.md', 'one'); await sync(device);
	const checkpoint = await saveCheckpoint();
	await ageCheckpoints(30 * DAY_MS);
	expect(await device.api.sharedHistory.list()).toEqual([]);
	await expect(device.api.sharedHistory.load(checkpoint.id)).rejects.toThrow('expired');
	await pruneSharedCheckpoints(env.DB);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM history_checkpoints').first<{ count: number }>()).toEqual({ count: 0 });
});

it('keeps every checkpoint of the last day, the first of each hour for a week and the first of each day after', async () => {
	const now = Date.UTC(2026, 10, 22, 12);
	const hour = 3_600_000;
	const ages = [0, 2 * hour, 23 * hour, // the last day: all kept
		30 * hour + 10 * 60_000, 30 * hour + 20 * 60_000, // one clock hour, two days ago: the first kept
		8 * DAY_MS + hour, 8 * DAY_MS + 5 * hour]; // one day, eight days ago: the first kept
	const times = ages.map(age => now - age);
	await env.DB.batch(times.map((time, index) => env.DB.prepare('INSERT INTO history_checkpoints (seq, created_at, file_count) VALUES (?, ?, 1)').bind(times.length - index, time)));
	await pruneSharedCheckpoints(env.DB, now);
	const kept = (await env.DB.prepare('SELECT created_at FROM history_checkpoints ORDER BY seq DESC').all<{ created_at: number }>()).results.map(row => now - row.created_at);
	expect(kept).toEqual([0, 2 * hour, 23 * hour, 30 * hour + 20 * 60_000, 8 * DAY_MS + 5 * hour]);
});

it('lists the newest checkpoints to clients that accept fewer', async () => {
	const device = new SyncTestDevice('shared-limit', env); clients.push(device);
	await device.authorize(); await device.open();
	const count = SELF_HOSTED_SHARED_CHECKPOINTS + 5;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
		INSERT INTO history_checkpoints (seq, created_at, file_count) SELECT x, CAST(strftime('%s', 'now') AS INTEGER) * 1000 - x, 1 FROM n`).bind(count).run();
	expect(await device.api.sharedHistory.list()).toHaveLength(count);
	const newest = ((await (await worker.fetch(new Request('https://crate.test/sync/checkpoints',
		{ headers: { Authorization: `Bearer ${device.id}` } }), env)).json()) as { checkpoints: SharedCheckpoint[] }).checkpoints;
	expect(newest).toHaveLength(SELF_HOSTED_SHARED_CHECKPOINTS);
	expect(newest[0]!.id).toBe(checkpointId(count));
});

it('rejects reminder-only tokens and arbitrary object keys', async () => {
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path) VALUES ('reminder',?,'reminders','Notes')").bind(await sha256Hex('reminder')).run();
	for (const route of ['/sync/checkpoints', '/sync/checkpoint?id=12345678-1234-1234-1234-123456789012', '/sync/checkpoint-file?id=12345678-1234-1234-1234-123456789012&path=note.md&revision=__crate__/settings.json']) {
		expect((await worker.fetch(new Request(`https://worker.test${route}`, { headers: { Authorization: 'Bearer reminder' } }), env)).status).toBe(403);
	}
	const device = new SyncTestDevice('shared-auth', env); clients.push(device); await device.authorize(); await device.open();
	device.disk.write('note.md', 'one'); await sync(device);
	const checkpoint = await saveCheckpoint();
	const response = await worker.fetch(new Request(`https://worker.test/sync/checkpoint-file?id=${checkpoint.id}&path=note.md&revision=__crate__/settings.json`, { headers: { Authorization: `Bearer ${device.id}` } }), env);
	expect(response.status).toBe(410);
});

it.each(['update', 'delete'])('retains checkpoint bytes for thirty days from commit even when an earlier %s request supplied an older clock', async action => {
	const device = new SyncTestDevice(`shared-retention-${action}`, env); clients.push(device);
	await device.authorize(); await device.open(); device.disk.write('note.md', 'original'); await sync(device);
	const checkpoint = await saveCheckpoint();
	vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 5 * 60_000);
	if (action === 'update') device.disk.write('note.md', 'new'); else device.disk.remove('note.md');
	await sync(device);
	const retained = await env.DB.prepare("SELECT kept_at FROM file_versions WHERE path='note.md'").first<{ kept_at: number }>();
	expect(retained!.kept_at + 30 * DAY_MS).toBeGreaterThanOrEqual(checkpoint.expiresAt);
});

it('streams a checkpoint above the former 100,000-file limit', async () => {
	const count = CHECKPOINT_PAGE_SIZE * 10 + 5;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT INTO files(path, portable_path, hash, size, storage_key, live_from_seq) SELECT 'n/'||x||'.md', 'n/'||x||'.md', ?, x, '__crate__/files/k'||x, 1 FROM n`)
		.bind(count, 'a'.repeat(64)).run();
	await env.DB.prepare("INSERT INTO server_state (id, file_count) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET file_count = excluded.file_count").bind(count).run();
	await env.DB.prepare("INSERT INTO changelog(seq, path, action, hash, size) VALUES (1, 'n/1.md', 'put', '', 0)").run();
	const checkpoint = await saveCheckpoint();
	expect(checkpoint.fileCount).toBe(count);
	const streamed = await getSharedCheckpoint(new Request(`https://test/sync/checkpoint?id=${checkpoint.id}`), env.DB);
	const document = parseSharedCheckpointDocument(await streamed.json());
	expect(document.checkpoint.fileCount).toBe(count);
	expect(document.files['n/7.md']).toMatchObject({ size: 7, revision: '__crate__/files/k7' });
}, 120_000);

/** A small deterministic generator, so a failure replays. */
function random(seed: number) {
	return (limit: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % limit; };
}

it.each([1, 2, 3])('rebuilds every surviving checkpoint as the vault was, across thinning and expiry (seed %i)', async seed => {
	const next = random(seed);
	const device = new SyncTestDevice(`rebuild-${seed}`, env); clients.push(device);
	await device.authorize(60 * DAY_MS); await device.open();
	const paths = ['a.md', 'b.md', 'c.md', 'Folder/d.md', 'Folder/e.bin'];
	await device.disk.vault.createFolder('Folder');
	// The vault after each sync, by the sequence it ended at. A commit saves a checkpoint
	// before its changes, which may fall between the commits of one sync.
	const states = new Map<number, Record<string, string>>();
	const record = async () => {
		const files = (await device.api.getManifest()).files;
		const seq = (await env.DB.prepare(`SELECT ${LAST_SEQ_SQL} AS seq`).first<{ seq: number }>())!.seq;
		states.set(seq, Object.fromEntries(Object.entries(files).map(([path, entry]) => [path, entry.hash])));
		// The counter every commit keeps matches the rows.
		expect(await env.DB.prepare('SELECT (SELECT file_count FROM server_state WHERE id = 1) AS counted, (SELECT COUNT(*) FROM files) AS rows').first())
			.toEqual({ counted: Object.keys(files).length, rows: Object.keys(files).length });
	};
	device.disk.write('a.md', 'seed'); await sync(device); await record();
	const expected = new Map<string, Record<string, string>>();
	for (let round = 0; round < 12; round++) {
		for (let edit = 0; edit <= next(3); edit++) {
			const path = paths[next(paths.length)]!;
			const present = device.disk.paths().includes(path);
			const action = next(4);
			if (present && action === 0) device.disk.remove(path);
			else if (present && action === 1) {
				const target = paths[next(paths.length)]!;
				if (!device.disk.paths().includes(target)) device.disk.rename(path, target);
			} else device.disk.write(path, `${path} round ${round} edit ${edit}`);
		}
		if (next(2)) await ageCheckpoints();
		await sync(device); await record();
		if (next(3) === 0) await saveCheckpoint();
		for (const checkpoint of await device.api.sharedHistory.list()) {
			if (expected.has(checkpoint.id)) continue;
			const state = await replayed(states, checkpoint.sequence);
			expect(Object.keys(state)).toHaveLength(checkpoint.fileCount);
			expected.set(checkpoint.id, state);
		}
		// Halfway, everything so far becomes twenty days older.
		if (round === 5) {
			await env.DB.prepare('UPDATE history_checkpoints SET created_at = created_at - ?').bind(20 * DAY_MS).run();
			await env.DB.prepare('UPDATE file_versions SET kept_at = kept_at - ?').bind(20 * DAY_MS).run();
		}
	}
	// Fifteen days on, the first half is past the thirty-day history period.
	const later = Date.now() + 15 * DAY_MS;
	vi.spyOn(Date, 'now').mockReturnValue(later);
	await pruneSharedCheckpoints(env.DB, later);
	while (await expireFileVersions(env.BUCKET, env.DB, later)) { /* drain */ }
	const surviving = await device.api.sharedHistory.list();
	expect(surviving.length).toBeGreaterThan(0);
	for (const checkpoint of surviving) {
		const document = await device.api.sharedHistory.load(checkpoint.id);
		const rebuilt = Object.fromEntries(Object.entries(document.files).map(([path, entry]) => [path, entry.hash]));
		expect(rebuilt, checkpoint.id).toEqual(expected.get(checkpoint.id));
		for (const [path, entry] of Object.entries(document.files)) {
			expect(await sha256Hex(await device.api.sharedHistory.download(checkpoint.id, path, entry))).toBe(entry.hash);
		}
	}
}, 120_000);

/** The vault at `seq`: the latest state recorded at or before it, then its changelog. */
async function replayed(states: Map<number, Record<string, string>>, seq: number): Promise<Record<string, string>> {
	const from = Math.max(...[...states.keys()].filter(recorded => recorded <= seq));
	const state = { ...states.get(from)! };
	const rows = await env.DB.prepare('SELECT path, action, hash FROM changelog WHERE seq > ? AND seq <= ? ORDER BY seq').bind(from, seq).all<{ path: string; action: string; hash: string }>();
	for (const row of rows.results) {
		if (row.action === 'delete') delete state[row.path];
		else state[row.path] = row.hash;
	}
	return state;
}
