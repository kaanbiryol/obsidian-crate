/// <reference types="@cloudflare/vitest-plugin/types" />
import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { countD1Queries } from './d1-query-count';
import { installD1QueryCounter } from './test-support/d1-query-test-harness';

it('counts each query and each batch once, as the per-invocation limit does', async () => {
	const { db, count } = countD1Queries(env.DB);
	await db.exec('CREATE TABLE IF NOT EXISTS query_count_probe (value INTEGER)');
	const insert = db.prepare('INSERT INTO query_count_probe (value) VALUES (?)');
	await insert.bind(1).run();
	await db.prepare('SELECT value FROM query_count_probe').first();
	await db.prepare('SELECT value FROM query_count_probe WHERE value = ?').bind(1).all();
	expect(count).toEqual({ queries: 4, statements: 4 });
	await db.batch([insert.bind(2), insert.bind(3), db.prepare('SELECT 1')]);
	expect(count).toEqual({ queries: 5, statements: 7 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM query_count_probe').first()).toEqual({ n: 3 });
});

it('counts queries made through the binding until mocks are restored', async () => {
	const count = installD1QueryCounter(env.DB);
	await env.DB.batch([env.DB.prepare('SELECT 1'), env.DB.prepare('SELECT 2')]);
	await env.DB.prepare('SELECT 3').first();
	expect({ queries: count.queries, statements: count.statements }).toEqual({ queries: 2, statements: 3 });
	vi.restoreAllMocks();
	await env.DB.prepare('SELECT 4').first();
	expect(count.queries).toBe(2);
});
