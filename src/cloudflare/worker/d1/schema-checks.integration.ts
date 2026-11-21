/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';

// These columns hold choices the Worker makes, so their checks bound the value instead of
// listing it: a new choice ships as a Worker change, with no migration.
beforeEach(() => applySchema(env.DB));
afterEach(reset);

const run = (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values).run();

it('stores any history period from 1 to 365 days', async () => {
	await run('INSERT INTO server_state (id) VALUES (1) ON CONFLICT(id) DO NOTHING');
	const store = (days: number) => run('UPDATE server_state SET history_retention_days = ? WHERE id = 1', days);
	for (const days of [1, 45, 365]) await expect(store(days)).resolves.toBeDefined();
	for (const days of [0, 366]) await expect(store(days)).rejects.toThrow(/CHECK/);
});

it('stores a grant or operation kind the Worker has not used before', async () => {
	const grant = (kind: string) => run('INSERT INTO grants (kind, key, payload, expires_at) VALUES (?, ?, ?, ?)', kind, kind, '{}', Date.now());
	const operation = (kind: string) => run('INSERT INTO operations (kind, operation_id, request_hash, response_json) VALUES (?, ?, ?, ?)', kind, kind, 'hash', '{}');
	for (const store of [grant, operation]) {
		await expect(store('future_kind')).resolves.toBeDefined();
		for (const kind of ['', 'k'.repeat(33)]) await expect(store(kind)).rejects.toThrow(/CHECK/);
	}
});
