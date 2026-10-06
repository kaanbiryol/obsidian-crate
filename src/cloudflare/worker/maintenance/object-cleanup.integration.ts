/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import { runScheduledMaintenance } from '../maintenance';

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
