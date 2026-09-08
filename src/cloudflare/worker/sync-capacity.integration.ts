/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { sha256Hex } from './auth';

// Actual client, Worker, D1 and R2; only the host filesystem is an in-memory seam.
// Wall times describe this local workerd run, not a hosted or physical-device SLA.
const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	// Explicitly clear this benchmark's local bindings. The workerd reset helper
	// alone left D1 rows after the 10,000-file run in this local runtime.
	for (const [, table] of schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)) {
		if (table !== 'crate_schema') await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	let page = await env.BUCKET.list();
	while (page.objects.length) {
		await env.BUCKET.delete(page.objects.map(object => object.key));
		page = await env.BUCKET.list();
	}
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first()).toEqual({ n: 0 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens').first()).toEqual({ n: 0 });
});
afterEach(async () => {
	for (const device of devices.splice(0)) device.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await reset();
});

async function device(id: string) {
	const device = new SyncTestDevice(id, env);
	devices.push(device);
	await device.authorize(60 * 60_000);
	await device.open();
	return device;
}

async function checkedSync(device: SyncTestDevice, initial = false) {
	const result = await (initial ? device.engine.initialSync() : device.engine.sync());
	expect(result.errors, JSON.stringify(result)).toEqual([]);
	expect(result.success).toBe(true);
	return result;
}

it.for([1000, 10000].flatMap(count => [false, true].map(initial => ({ count, initial }))))(
	'converges $count nested notes through cold, warm and restarted synchronization (explicit initial=$initial)',
	{ timeout: 900_000 }, async ({ count, initial }, context) => {
		const first = await device('capacity-first');
		const expected = new Map<string, string>();
		for (let directory = 0; directory < 100; directory++) {
			await first.disk.vault.createFolder(`Notes/Group-${String(directory).padStart(3, '0')}`);
		}
		for (let index = 0; index < count; index++) {
			const path = `Notes/Group-${String(index % 100).padStart(3, '0')}/Note-${String(index).padStart(5, '0')}.md`;
			const content = `# Note ${index}\n\n${'Capacity fixture with distinct file bytes. '.repeat(24)}\n`;
			expected.set(path, content);
			first.disk.write(path, content);
		}
		const prepare = vi.spyOn(env.DB, 'prepare');
		const get = vi.spyOn(env.BUCKET, 'get');
		const put = vi.spyOn(env.BUCKET, 'put');
		const samples: unknown[] = [];
		async function measure(phase: string, client: SyncTestDevice, initial = false) {
			prepare.mockClear(); get.mockClear(); put.mockClear();
			const start = performance.now();
			const offset = client.responses.length;
			const result = await checkedSync(client, initial);
			const responses = client.responses.slice(offset);
			const routes: Record<string, number> = {};
			for (const response of responses) routes[response.route] = (routes[response.route] ?? 0) + 1;
			samples.push({ phase, wallMs: Math.round(performance.now() - start), requests: responses.length,
				routes, responseBytes: responses.reduce((sum, response) => sum + response.bytes, 0),
				longestRequestMs: Math.round(Math.max(0, ...responses.map(response => response.wallMs))),
				preparedStatements: prepare.mock.calls.length, r2Gets: get.mock.calls.length, r2Puts: put.mock.calls.length,
				uploaded: result.uploaded, downloaded: result.downloaded, deleted: result.deleted });
			return result;
		}
		await measure(initial ? 'explicit-initial-upload' : 'cold-full-upload', first, initial);
		expect(first.disk.paths()).toHaveLength(count);
		const second = await device('capacity-second');
		await measure('cold-download', second);
		for (const client of [first, second]) {
			const result = await measure('warm-unchanged', client);
			expect(result.uploaded + result.downloaded + result.deleted).toBe(0);
		}
		first.close(); second.close();
		const paths = [...expected.keys()];
		// Distinct edits, deletes, creates and renames made by disconnected replicas.
		for (let index = 0; index < 100; index++) {
			const path = paths[index]!;
			if (index % 4 === 0) {
				const content = `${expected.get(path)!}\nEdited offline.\n`;
				first.disk.write(path, content); expected.set(path, content);
			} else if (index % 4 === 1) {
				second.disk.remove(path); expected.delete(path);
			} else if (index % 4 === 2) {
				const renamed = path.replace('.md', '-renamed.md');
				first.disk.rename(path, renamed); expected.set(renamed, expected.get(path)!); expected.delete(path);
			} else {
				const created = path.replace('.md', '-new.md');
				second.disk.write(created, 'Created while disconnected.\n'); expected.set(created, 'Created while disconnected.\n');
			}
		}
		await first.open(); await second.open();
		await measure('restart-offline-first', first);
		await measure('restart-offline-second', second);
		await measure('converge-first', first);
		await measure('converge-second', second);
		const manifest = await first.api.getManifest();
		expect(Object.keys(manifest.files).sort()).toEqual([...expected.keys()].sort());
		for (const client of [first, second]) {
			expect(client.disk.paths()).toEqual([...expected.keys()].sort());
			expect(Object.keys(client.checkpoint().files).sort()).toEqual([...expected.keys()].sort());
			for (const [path, content] of expected) expect(client.disk.text(path), path).toBe(content);
		}
		for (const [path, content] of expected) expect(manifest.files[path]!.hash, path).toBe(await sha256Hex(content));
		await context.annotate(JSON.stringify({ scenario: 'real-sync-engine-capacity', localOnly: true,
			files: count, directories: 100, explicitInitial: initial, offlineOperations: 100, samples }), 'capacity');
	});
