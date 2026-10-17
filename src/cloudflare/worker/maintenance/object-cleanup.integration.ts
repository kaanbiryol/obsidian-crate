/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import { runScheduledMaintenance } from '../maintenance';
import { runMaintenanceEpisode } from './lifecycle';

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('retains failed cleanup and its diagnostic until a successful retry', async () => {
	const key = 'queued-object';
	await env.BUCKET.put(key, 'unreferenced bytes');
	await env.DB.prepare('INSERT INTO object_cleanup_queue (storage_key, file_path) VALUES (?, ?)')
		.bind(key, 'notes/test.md').run();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(env.BUCKET, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'));

	expect(await runScheduledMaintenance(env)).toBe(0);
	expect(await env.BUCKET.get(key)).not.toBeNull();
	expect(await env.DB.prepare('SELECT storage_key FROM object_cleanup_queue').first()).toEqual({ storage_key: key });
	expect(await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'last_error'").first())
		.toEqual({ value: 'drain object cleanup: R2 unavailable' });

	expect(await runScheduledMaintenance(env)).toBe(1);
	expect(await env.BUCKET.get(key)).toBeNull();
	expect(await env.DB.prepare('SELECT storage_key FROM object_cleanup_queue').first()).toBeNull();
	expect(await env.DB.prepare("SELECT value FROM maintenance_state WHERE key = 'last_error'").first()).toBeNull();
});

it('drains thousands of expired versions within bounded passes and keeps referenced objects', async () => {
	const versions = Array.from({ length: 6000 }, (_, i) => ({ storageKey: `__crate__/files/hash/${i}`, path: `notes/${i}.md` }));
	const restored = versions.filter((_, i) => i % 1000 === 0);
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO file_versions (storage_key, path, hash, size, reason, expires_at)
			SELECT json_extract(value, '$.storageKey'), json_extract(value, '$.path'), 'hash', 1, 'replaced', 0 FROM json_each(?)`)
			.bind(JSON.stringify(versions)),
		// Restored versions are current again, and a stale intent targets an unexpired version.
		env.DB.prepare(`INSERT INTO files (path, portable_path, storage_key)
			SELECT json_extract(value, '$.path'), json_extract(value, '$.path'), json_extract(value, '$.storageKey') FROM json_each(?)`)
			.bind(JSON.stringify(restored)),
		env.DB.prepare(`INSERT INTO file_versions (storage_key, path, hash, size, reason, expires_at)
			VALUES ('retained', 'notes/retained.md', 'hash', 1, 'replaced', ?)`).bind(Date.now() + 86_400_000),
		env.DB.prepare("INSERT INTO object_cleanup_queue (storage_key, file_path) VALUES ('retained', 'notes/retained.md')"),
	]);
	for (let i = 0; i < versions.length; i += 500) {
		await Promise.all(versions.slice(i, i + 500).map(version => env.BUCKET.put(version.storageKey, 'bytes')));
	}
	await env.BUCKET.put('retained', 'bytes');

	const values = new Map<string, unknown>();
	const setAlarm = vi.fn();
	const state = { storage: { get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm } } as never;
	const queueReads = new Set<string>();
	let passes = 0;
	do {
		passes++;
		setAlarm.mockClear();
		const prepare = vi.spyOn(env.DB, 'prepare');
		await runMaintenanceEpisode(state, env);
		// Free Workers allow 50 D1 queries per invocation, regardless of batch size.
		expect(prepare.mock.calls.length).toBeLessThanOrEqual(50);
		for (const [sql] of prepare.mock.calls) if (sql.startsWith('SELECT') && sql.includes('FROM object_cleanup_queue ORDER BY')) queueReads.add(sql);
		prepare.mockRestore();
	} while (setAlarm.mock.calls.length && passes < 20);

	// 6,001 queued objects at 500 per pass, beyond the ten-pass limit for other work.
	expect(passes).toBe(13);
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM object_cleanup_queue').first()).toEqual({ n: 0 });
	expect((await env.DB.prepare('SELECT storage_key FROM file_versions').all()).results).toEqual([{ storage_key: 'retained' }]);
	expect((await env.BUCKET.list()).objects.map(object => object.key).sort())
		.toEqual([...restored.map(version => version.storageKey), 'retained'].sort());
	expect(queueReads.size).toBe(2);
	for (const sql of queueReads) {
		const statement = env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`);
		const plan = await (sql.includes('?') ? statement.bind(500) : statement).all<{ detail: string }>();
		expect(plan.results.map(row => row.detail)).toEqual(['SCAN object_cleanup_queue']);
	}
}, 60_000);
