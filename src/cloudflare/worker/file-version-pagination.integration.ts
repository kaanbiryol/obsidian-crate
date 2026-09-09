/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleListFileVersions } from './file-version-list';
import { handleRestoreFileVersion } from './file-version-handlers';
import { parseFileVersions } from '../../sync/worker-api/version-contract';
import { sha256Hex } from './auth';

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	const hash = await sha256Hex('retained bytes');
	await env.DB.batch(Array.from({ length: 205 }, (_, i) => env.DB.prepare(`INSERT INTO file_versions
		(storage_key, path, hash, size, reason, created_at, expires_at) VALUES (?, ?, ?, 14, 'deleted', '2026-09-09 12:00:00', ?)`)
		.bind(`retained/${String(i).padStart(3, '0')}`, i === 0 ? 'archive/older%.md' : `notes/${i}.md`, hash, Date.now() + 300_000)));
});
afterEach(async () => { await reset(); });
const request = (params: Record<string, string> = {}) => new Request(`https://worker.test/sync/versions?${new URLSearchParams(params)}`);
const list = async (params?: Record<string, string>) => parseFileVersions(await (await handleListFileVersions(request(params), env.DB)).json());

it('walks all equal-timestamp pages without duplicates and restores an entry beyond the first 100', async () => {
	const first = await list();
	expect(first.versions).toHaveLength(100);
	// A newly retained row cannot shift the cursor and repeat older entries.
	await env.DB.prepare(`INSERT INTO file_versions SELECT 'retained/zzz', 'new.md', hash, size, reason, created_at, expires_at FROM file_versions LIMIT 1`).run();
	const second = await list({ cursor: first.nextCursor! });
	const third = await list({ cursor: second.nextCursor! });
	expect(second.versions).toHaveLength(100);
	expect(third.versions).toHaveLength(5);
	expect(third.hasMore).toBe(false);
	const all = [...first.versions, ...second.versions, ...third.versions];
	expect(new Set(all.map(row => row.storage_key)).size).toBe(205);
	const older = all.at(-1)!;
	expect(older.path).toBe('archive/older%.md');
	await env.BUCKET.put(older.storage_key, 'retained bytes', { customMetadata: { hash: older.hash } });
	const restored = await handleRestoreFileVersion(new Request('https://worker.test/sync/versions/restore', {
		method: 'POST', body: JSON.stringify({ storageKey: older.storage_key, expectedHash: null }),
	}), env.BUCKET, env.DB);
	expect(restored.status).toBe(200);
	expect(await env.DB.prepare('SELECT hash FROM files WHERE path = ?').bind(older.path).first()).toEqual({ hash: older.hash });
});

it('searches literal filenames, excludes expired rows, and binds cursors to their search', async () => {
	expect((await list({ search: '%' })).versions.map(row => row.path)).toEqual(['archive/older%.md']);
	expect((await list({ path: 'archive/older%.md' })).versions).toHaveLength(1);
	expect((await list({ search: 'ARCHIVE/' })).versions).toHaveLength(1);
	const first = await list({ search: 'notes/' });
	expect((await handleListFileVersions(request({ search: 'archive/', cursor: first.nextCursor! }), env.DB)).status).toBe(400);
	await env.DB.prepare('UPDATE file_versions SET expires_at = 0 WHERE storage_key = ?').bind('retained/000').run();
	expect((await list({ search: '%' })).versions).toEqual([]);
});

it.each(['bad', btoa('[]'), btoa('[1,"not a date","key","",""]')])('rejects malformed history cursor %s', async cursor => {
	expect((await handleListFileVersions(request({ cursor }), env.DB)).status).toBe(400);
});

it('pages more than 100 retained revisions for one exact filename', async () => {
	await env.DB.prepare("UPDATE file_versions SET path = 'same.md'").run();
	let cursor: string | undefined;
	const keys: string[] = [];
	do {
		const page = await list({ path: 'same.md', ...(cursor ? { cursor } : {}) });
		keys.push(...page.versions.map(row => row.storage_key));
		cursor = page.nextCursor;
	} while (cursor);
	expect(keys).toHaveLength(205);
	expect(new Set(keys).size).toBe(205);
});
