/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL } from '../../../protocol/server-info';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sha256Hex } from '@/platform/sha256';
import { isAuthenticatedRouteAllowed } from '../router';
import { DAY_MS } from '../../../protocol/history-retention';
import { createSharedCheckpoint, listSharedCheckpoints } from '../sync/history-checkpoints';
import type { SharedCheckpoint } from '../../../protocol/history-checkpoints';
import { expireFileVersions } from '../maintenance/object-cleanup';
import { meterD1Usage } from '../d1/d1-usage';
import { handleHistoryRetention } from './history-retention-handler';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT OR REPLACE INTO auth_tokens (id, token_hash, scope) VALUES ('device', ?, 'vault')").bind(await sha256Hex('credential')).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function request(route: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://retention.test${route}`, {
		...init, headers: { Authorization: 'Bearer credential', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
			'X-Crate-Client-Session': '11111111-1111-4111-8111-111111111111', 'X-Crate-Operation-Id': crypto.randomUUID(), ...init.headers },
	}), env);
}
const retention = async () => (await (await request('/history-retention')).json() as { days: number }).days;
const setRetention = (days: unknown) => request('/history-retention', { method: 'POST', body: JSON.stringify({ days }) });

async function deleteFile(path: string) {
	const uploaded = await request(`/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: path,
		headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / DAY_MS)), 'X-Crate-Expected-Hash': 'absent' } });
	expect(uploaded.status).toBe(200);
	const file = await uploaded.json() as { path: string; hash: string; revision: string };
	const removed = await request('/sync/batch-delete', { method: 'POST', body: JSON.stringify({ files: [{ path, expectedHash: file.hash, expectedRevision: file.revision }] }) });
	expect(removed.status).toBe(200);
}
/** The listed expiry of `path`'s retained version, or undefined once it is hidden. */
const expiry = async (path: string) => (await (await request(`/sync/versions?path=${encodeURIComponent(path)}`)).json() as
	{ versions: { expires_at: number }[] }).versions[0]?.expires_at;
/** Backdates a kept version as if it were committed `days` ago. */
const backdate = (path: string, days: number) => env.DB.prepare(`UPDATE file_versions
	SET created_at = datetime('now', ?), kept_at = ? WHERE path = ?`).bind(`-${days} days`, Date.now() - days * DAY_MS, path).run();
const versionRows = async () => (await env.DB.prepare('SELECT path FROM file_versions ORDER BY path').all<{ path: string }>()).results.map(row => row.path);

it('defaults to 30 days, accepts only offered periods and limits it to vault credentials', async () => {
	expect(await retention()).toBe(30);
	expect((await setRetention(45)).status).toBe(400);
	expect((await setRetention('7')).status).toBe(400);
	expect((await setRetention(14)).status).toBe(200);
	expect(await retention()).toBe(14);
	expect((await setRetention(7)).status).toBe(200);
	expect(await retention()).toBe(7);
	for (const method of ['GET', 'POST']) {
		expect(isAuthenticatedRouteAllowed({ tokenId: 'browser', scope: 'reminders' }, '/history-retention', method)).toBe(false);
		expect(isAuthenticatedRouteAllowed({ tokenId: 'device', scope: 'vault' }, '/history-retention', method)).toBe(true);
	}
});

it('keeps versions for the current period', async () => {
	await setRetention(7);
	const started = Date.now();
	await deleteFile('short.md');
	expect(await expiry('short.md')).toBeGreaterThanOrEqual(started + 7 * DAY_MS);
	expect(await expiry('short.md')).toBeLessThan(Date.now() + 7 * DAY_MS + 2_000);
	await setRetention(60);
	await deleteFile('long.md');
	expect(await expiry('short.md')).toBeGreaterThanOrEqual(started + 60 * DAY_MS);
	expect(await expiry('long.md')).toBeGreaterThanOrEqual(started + 60 * DAY_MS);
});

it('changes the period with one row written, whatever history is kept', async () => {
	for (const path of ['a.md', 'b.md', 'c.md']) await deleteFile(path);
	await env.DB.prepare(`INSERT INTO file_versions (storage_key, path, hash, size, reason, kept_at)
		SELECT 'bulk/' || value, 'bulk/' || value || '.md', 'hash', 1, 'replaced', ? FROM json_each(?)`)
		.bind(Date.now() - 20 * DAY_MS, JSON.stringify(Array.from({ length: 500 }, (_, i) => i))).run();
	for (const days of [7, 90, 30]) {
		const meter = meterD1Usage(env.DB);
		const response = await handleHistoryRetention(new Request('https://retention.test/history-retention', { method: 'POST', body: JSON.stringify({ days }) }), meter.db);
		expect(response.status).toBe(200);
		expect(meter.usage).toMatchObject({ complete: true, queries: 1, rowsWritten: 1 });
	}
});

it('applies a changed period to kept versions without reviving ones maintenance started to remove', async () => {
	for (const path of ['recent.md', 'old.md']) await deleteFile(path);
	await backdate('recent.md', 2);
	await backdate('old.md', 20);

	await setRetention(7);
	expect(await expiry('recent.md')).toBeGreaterThan(Date.now() + 4 * DAY_MS);
	expect(await expiry('recent.md')).toBeLessThan(Date.now() + 6 * DAY_MS);
	expect(await expiry('old.md')).toBeUndefined();

	// Maintenance deletes the expired object, then stops before deleting its row.
	const interrupted = { prepare(sql: string) {
		if (sql.startsWith('DELETE FROM file_versions')) throw new Error('interrupted');
		return env.DB.prepare(sql);
	} } as unknown as D1Database;
	await expect(expireFileVersions(env.BUCKET, interrupted)).rejects.toThrow('interrupted');
	expect(await versionRows()).toEqual(['old.md', 'recent.md']);

	await setRetention(90);
	expect(await expiry('recent.md')).toBeGreaterThan(Date.now() + 87 * DAY_MS);
	// Its object may be gone, so the longer period leaves it hidden.
	expect(await expiry('old.md')).toBeUndefined();
	expect(await expireFileVersions(env.BUCKET, env.DB)).toBe(false);
	expect(await versionRows()).toEqual(['recent.md']);
});

/** A one-file vault at a new sequence, so the next save names a new state. */
async function changeVault(path: string) {
	await env.DB.prepare("INSERT INTO changelog(path, action, hash, size) VALUES (?, 'put', '', 0)").bind(path).run();
	await env.DB.prepare("INSERT INTO server_state (id, file_count) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET file_count = 1").run();
}
const save = async () => (await (await createSharedCheckpoint(env.DB)).json() as { checkpoint: SharedCheckpoint }).checkpoint;
/** Moves every checkpoint `days` into the past, as if saved then. */
const age = (days: number) => env.DB.prepare('UPDATE history_checkpoints SET created_at = created_at - ?').bind(days * DAY_MS).run();
const listed = async () => (await (await listSharedCheckpoints(new Request('https://crate.test/sync/checkpoints?all=1'), env.DB)).json() as { checkpoints: SharedCheckpoint[] }).checkpoints;

it('saves checkpoints for the chosen period and hides older ones after shortening it', async () => {
	await changeVault('a.md');
	const created = await save();
	expect(created.expiresAt - Date.parse(created.timestamp)).toBe(30 * DAY_MS);
	await age(10);
	expect(await listed()).toHaveLength(1);

	await setRetention(7);
	expect(await listed()).toEqual([]);
	await changeVault('b.md');
	const next = await save();
	expect(next.expiresAt - Date.parse(next.timestamp)).toBe(7 * DAY_MS);
	expect((await listed()).map(entry => entry.id)).toEqual([next.id]);
});

it('keeps checkpoints hidden after a longer period once maintenance removed versions they need', async () => {
	await changeVault('a.md');
	const old = await save();
	await age(10);
	// A file the checkpoint saw was replaced nine days ago.
	await deleteFile('replaced.md');
	await backdate('replaced.md', 9);

	await setRetention(7);
	expect(await expireFileVersions(env.BUCKET, env.DB)).toBe(false);
	expect(await versionRows()).toEqual([]);
	await setRetention(30);
	// Only the checkpoint the deletion's commit saved before it remains.
	expect((await listed()).map(entry => entry.id)).not.toContain(old.id);
	expect(await listed()).toHaveLength(1);
});

it('starts a hidden checkpoint of an unchanged vault again from now', async () => {
	await changeVault('a.md');
	const old = await save();
	await age(40);
	expect(await listed()).toEqual([]);
	const next = await save();
	expect(next.id).toBe(old.id);
	expect((await listed()).map(entry => entry.id)).toEqual([next.id]);
});
