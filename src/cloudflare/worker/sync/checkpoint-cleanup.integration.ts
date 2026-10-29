/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createSharedCheckpoint } from './history-checkpoints';
import { runMaintenanceEpisode } from '../maintenance/lifecycle';
import { HISTORY_CHECKPOINT_PREFIX, HISTORY_INDEX_KEY } from '../../../protocol/storage-keys';
import { MAX_SHARED_CHECKPOINTS, type SharedCheckpoint } from '../../../protocol/history-checkpoints';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const change = () => env.DB.prepare("INSERT INTO changelog(path, action, hash, size) VALUES ('test.md', 'delete', '', 0)").run();
async function create(bucket: R2Bucket = env.BUCKET): Promise<Response> {
	await change();
	return createSharedCheckpoint(bucket, env.DB);
}
async function index(): Promise<SharedCheckpoint[]> {
	return (JSON.parse(await (await env.BUCKET.get(HISTORY_INDEX_KEY))!.text()) as { checkpoints: SharedCheckpoint[] }).checkpoints;
}
async function inventories(): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: HISTORY_CHECKPOINT_PREFIX, ...(cursor ? { cursor } : {}) });
		keys.push(...page.objects.map(object => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys.sort();
}
const keysOf = (checkpoints: SharedCheckpoint[]) => checkpoints.map(entry => `${HISTORY_CHECKPOINT_PREFIX}${entry.id}.json`).sort();

it('deletes the inventories of checkpoints that leave the index when it is rewritten', async () => {
	for (let count = 0; count < MAX_SHARED_CHECKPOINTS + 3; count++) expect((await create()).status).toBe(200);
	expect(await index()).toHaveLength(MAX_SHARED_CHECKPOINTS);
	expect(await inventories()).toEqual(keysOf(await index()));
});

it('deletes expired inventories and those a concurrent same-state save never published', async () => {
	await create();
	const [expired] = await index();
	await env.BUCKET.put(HISTORY_INDEX_KEY, JSON.stringify({ version: 1, checkpoints: [{ ...expired, timestamp: new Date(Date.now() - 2000).toISOString(), expiresAt: Date.now() - 1000 }] }));
	await change();
	const [one, two] = await Promise.all([createSharedCheckpoint(env.BUCKET, env.DB), createSharedCheckpoint(env.BUCKET, env.DB)]);
	expect((await one.json() as { checkpoint: SharedCheckpoint }).checkpoint.id).toBe((await two.json() as { checkpoint: SharedCheckpoint }).checkpoint.id);
	expect(await index()).toHaveLength(1);
	expect(await inventories()).toEqual(keysOf(await index()));
});

it('deletes only what its own index write dropped when another writer publishes first', async () => {
	for (let count = 0; count < MAX_SHARED_CHECKPOINTS; count++) await create();
	let raced = false;
	const bucket = new Proxy(env.BUCKET, { get(target, property) {
		if (property === 'put') return async (key: string, body: string, options?: R2PutOptions) => {
			// The other writer publishes a newer state between this writer's read and write.
			if (key === HISTORY_INDEX_KEY && !raced) { raced = true; expect((await create()).status).toBe(200); }
			return target.put(key, body, options);
		};
		const value = Reflect.get(target, property) as unknown;
		return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	const response = await create(bucket);
	expect(raced).toBe(true);
	expect(response.status, await response.clone().text()).toBe(200);
	const { checkpoint } = await response.json() as { checkpoint: SharedCheckpoint };
	const current = await index();
	expect(current).toHaveLength(MAX_SHARED_CHECKPOINTS);
	expect(current.map(entry => entry.id)).toContain(checkpoint.id);
	expect(await inventories()).toEqual(keysOf(current));
});

it('continues the maintenance sweep while trimmed inventories remain', async () => {
	await create();
	const live = await inventories();
	const orphans = Array.from({ length: 2500 }, (_, index) => `${HISTORY_CHECKPOINT_PREFIX}orphan-${String(index).padStart(4, '0')}.json`);
	for (let start = 0; start < orphans.length; start += 500) await Promise.all(orphans.slice(start, start + 500).map(key => env.BUCKET.put(key, '{}')));
	vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86_400_000);
	const values = new Map<string, unknown>();
	const setAlarm = vi.fn();
	const state = { storage: { get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm } } as never;
	let passes = 0;
	do {
		passes++;
		setAlarm.mockClear();
		await runMaintenanceEpisode(state, env);
	} while (setAlarm.mock.calls.length && passes < 10);
	expect(passes).toBe(3);
	expect(await inventories()).toEqual(live);
});
