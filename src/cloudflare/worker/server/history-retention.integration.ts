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
import { HISTORY_INDEX_KEY } from '../../../protocol/storage-keys';
import type { SharedCheckpoint } from '../../../protocol/history-checkpoints';

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
const expiry = async (path: string) => (await env.DB.prepare('SELECT expires_at FROM file_versions WHERE path = ?').bind(path).first<{ expires_at: number }>())!.expires_at;
/** Backdates a kept version as if it were committed `days` ago under `retention` days. */
const backdate = (path: string, days: number, retention: number) => env.DB.prepare(`UPDATE file_versions
	SET created_at = datetime('now', ?), expires_at = ? WHERE path = ?`).bind(`-${days} days`, Date.now() + (retention - days) * DAY_MS, path).run();

it('defaults to 30 days, accepts only offered periods and limits it to vault credentials', async () => {
	expect(await retention()).toBe(30);
	expect((await setRetention(14)).status).toBe(400);
	expect((await setRetention('7')).status).toBe(400);
	expect((await setRetention(7)).status).toBe(200);
	expect(await retention()).toBe(7);
	for (const method of ['GET', 'POST']) {
		expect(isAuthenticatedRouteAllowed({ tokenId: 'browser', scope: 'reminders' }, '/history-retention', method)).toBe(false);
		expect(isAuthenticatedRouteAllowed({ tokenId: 'device', scope: 'vault' }, '/history-retention', method)).toBe(true);
	}
});

it('keeps new versions for the chosen period', async () => {
	await setRetention(7);
	const started = Date.now();
	await deleteFile('short.md');
	expect(await expiry('short.md')).toBeGreaterThanOrEqual(started + 7 * DAY_MS);
	expect(await expiry('short.md')).toBeLessThan(Date.now() + 7 * DAY_MS + 2_000);
	await setRetention(60);
	await deleteFile('long.md');
	expect(await expiry('long.md')).toBeGreaterThanOrEqual(started + 60 * DAY_MS);
});

it('re-times kept versions when the period changes, without reviving expired ones', async () => {
	for (const path of ['recent.md', 'old.md', 'expired.md']) await deleteFile(path);
	await backdate('recent.md', 2, 30);
	await backdate('old.md', 20, 30);
	await env.DB.prepare('UPDATE file_versions SET expires_at = ? WHERE path = ?').bind(Date.now() - 1, 'expired.md').run();

	await setRetention(7);
	expect(await expiry('recent.md')).toBeGreaterThan(Date.now() + 4 * DAY_MS);
	expect(await expiry('recent.md')).toBeLessThan(Date.now() + 6 * DAY_MS);
	expect(await expiry('old.md')).toBeLessThan(Date.now());

	await setRetention(90);
	expect(await expiry('recent.md')).toBeGreaterThan(Date.now() + 87 * DAY_MS);
	// Shortened past its expiry, the version is treated as removed and stays expired.
	expect(await expiry('old.md')).toBeLessThan(Date.now());
	expect(await expiry('expired.md')).toBeLessThan(Date.now());
});

it('saves checkpoints for the chosen period and hides older ones after shortening it', async () => {
	await env.DB.prepare("INSERT INTO changelog(path, action, hash, size) VALUES ('a.md', 'delete', '', 0)").run();
	const created = await (await createSharedCheckpoint(env.BUCKET, env.DB)).json() as { checkpoint: SharedCheckpoint };
	expect(created.checkpoint.expiresAt - Date.parse(created.checkpoint.timestamp)).toBe(30 * DAY_MS);
	// Rewrite the index as if the checkpoint were saved ten days ago.
	const old = { ...created.checkpoint, timestamp: new Date(Date.now() - 10 * DAY_MS).toISOString(), expiresAt: Date.now() + 20 * DAY_MS };
	await env.BUCKET.put(HISTORY_INDEX_KEY, JSON.stringify({ version: 1, checkpoints: [old] }));
	const listed = async () => (await (await listSharedCheckpoints(env.BUCKET, env.DB)).json() as { checkpoints: SharedCheckpoint[] }).checkpoints;
	expect(await listed()).toHaveLength(1);

	await setRetention(7);
	expect(await listed()).toEqual([]);
	await env.DB.prepare("INSERT INTO changelog(path, action, hash, size) VALUES ('b.md', 'delete', '', 0)").run();
	const next = await (await createSharedCheckpoint(env.BUCKET, env.DB)).json() as { checkpoint: SharedCheckpoint };
	expect(next.checkpoint.expiresAt - Date.parse(next.checkpoint.timestamp)).toBe(7 * DAY_MS);
	expect((await listed()).map(entry => entry.id)).toEqual([next.checkpoint.id]);
});
