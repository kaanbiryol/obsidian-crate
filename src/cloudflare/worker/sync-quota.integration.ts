/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { CHANGELOG_BOUNDS_SQL } from './sync-storage';
import { findReferencedStorageKeys } from './storage-references';

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { await reset(); });

it.each([1000, 10000, 100000])('keeps idle polling and orphan reference lookup independent of %i retained rows', async count => {
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
		INSERT INTO changelog(path,action,hash,size,revision) SELECT 'note-'||x,'put','hash',1,'key-'||x FROM n`).bind(count).run();
	await env.DB.prepare(`INSERT INTO files(path,portable_path,hash,size,storage_key)
		SELECT path,path,hash,size,revision FROM changelog`).run();
	const result = await env.DB.prepare(CHANGELOG_BOUNDS_SQL).all() as { results: unknown[]; meta: { rows_read: number } };
	expect(result.results).toEqual([{ lastSeq: count, minSeq: 1 }]);
	expect(result.meta.rows_read).toBeLessThanOrEqual(2);
	// Two devices polling every five minutes, with two bound reads per cycle.
	expect(result.meta.rows_read * 2 * 2 * 288).toBeLessThan(5000);
	const query = await env.DB.prepare('SELECT storage_key FROM files WHERE storage_key IN (?, ?)').bind('key-1', 'missing').all() as unknown as { meta: { rows_read: number } };
	expect(query.meta.rows_read).toBeLessThanOrEqual(4);
	expect(await findReferencedStorageKeys(env.DB, ['key-1', 'missing'])).toEqual(new Set(['key-1']));
	const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT storage_key FROM files WHERE storage_key IN (?, ?)').bind('key-1', 'missing').all();
	expect(JSON.stringify(plan.results)).toContain('files_storage_key_idx');
});

it('preserves empty and pruned cursor bounds', async () => {
	expect((await env.DB.prepare(CHANGELOG_BOUNDS_SQL).all()).results).toEqual([{ lastSeq: null, minSeq: null }]);
	await env.DB.prepare("INSERT INTO changelog(seq,path,action,hash,size) VALUES (50,'note','put','hash',1)").run();
	expect((await env.DB.prepare(CHANGELOG_BOUNDS_SQL).all()).results).toEqual([{ lastSeq: 50, minSeq: 50 }]);
});
