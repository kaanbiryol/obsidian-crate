// Regression cases from the current-revision pre-release audit.
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { TEST_PLUGIN_DIR } from './sync-engine-vault-test-harness';
import worker from './index';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
	for (const device of devices.splice(0)) { device.close(); await device.engine.waitForIdle(); }
	vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});
async function device(id: string) {
	const result = new SyncTestDevice(id, env); devices.push(result);
	await result.authorize(3_600_000); await result.open(); return result;
}

it('refuses an unsupported successful manifest response before treating the local file as remotely deleted', async () => {
	const client = await device('audit-read-contract');
	client.disk.write('note.md', 'Original safe bytes');
	expect((await client.engine.sync()).errors).toEqual([]);
	client.settings.lastSeq = 0;
	const fetch = worker.fetch.bind(worker);
	vi.spyOn(worker, 'fetch').mockImplementation(async (request, bindings, context) => {
		const response = await fetch(request, bindings, context);
		if (new URL(request.url).pathname !== '/sync/manifest') return response;
		const current = await response.json() as { files: unknown; lastSeq: number };
		return Response.json({ version: 2, entries: current.files, lastSeq: current.lastSeq, snapshotSeq: current.lastSeq, hasMore: false });
	});
	const result = await client.engine.sync();
	expect(client.disk.has('note.md')).toBe(true);
	expect(result.success).toBe(false);
});

it('refuses a structurally damaged checkpoint instead of resurrecting a deletion', async () => {
	const a = await device('audit-checkpoint-a');
	a.disk.write('note.md', 'Original safe bytes');
	expect((await a.engine.sync()).errors).toEqual([]);
	const b = await device('audit-checkpoint-b');
	expect((await b.engine.sync()).errors).toEqual([]);
	a.close(); await a.engine.waitForIdle();
	const checkpoint = a.checkpoint();
	(checkpoint.files['note.md'] as unknown as { size: unknown }).size = 'damaged';
	a.disk.write(`${TEST_PLUGIN_DIR}/file-manifest.json`, JSON.stringify(checkpoint));
	b.disk.remove('note.md');
	expect((await b.engine.sync()).errors).toEqual([]);
	expect(await env.DB.prepare('SELECT path FROM files').first()).toBeNull();
	await expect(a.open()).rejects.toThrow();
	expect(a.disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`)).toBe(JSON.stringify(checkpoint));
	expect(a.disk.text('note.md')).toBe('Original safe bytes');
	expect(await env.DB.prepare('SELECT path FROM files').first()).toBeNull();
});
