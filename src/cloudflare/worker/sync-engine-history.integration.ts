/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { pruneChangelog } from './db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './sync-storage';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	vi.restoreAllMocks(); vi.unstubAllGlobals();
	await reset();
});
async function sync(client: SyncTestDevice) {
	const result = await client.engine.sync();
	expect(result.errors, `${client.id}: ${JSON.stringify(result)}`).toEqual([]);
	expect(result.success).toBe(true);
}
async function replicas(content: string) {
	for (let index = 0; index < 3; index++) {
		const client = new SyncTestDevice(`history-${index}`, env);
		clients.push(client);
		await client.authorize(60 * 60_000);
		await client.open();
		if (index === 0) client.disk.write('note.md', content);
		await sync(client);
	}
	return clients as [SyncTestDevice, SyncTestDevice, SyncTestDevice];
}
async function converged(expected: Record<string, string>) {
	for (const client of clients) await sync(client);
	for (const client of clients) {
		expect(client.disk.paths()).toEqual(Object.keys(expected).sort());
		for (const [path, content] of Object.entries(expected)) expect(client.disk.text(path), `${client.id}:${path}`).toBe(content);
	}
	const remote = await clients[0]!.api.getManifest();
	expect(Object.keys(remote.files).sort()).toEqual(Object.keys(expected).sort());
	for (const [path, content] of Object.entries(expected)) {
		expect(new TextDecoder().decode((await clients[0]!.api.downloadFile(path)).content)).toBe(content);
	}
}

it.for([[0, 1], [1, 0]])('preserves both disconnected rename destinations in arrival order %j', async order => {
	const devices = await replicas('original bytes\n');
	for (const client of devices.slice(0, 2)) client.close();
	devices[0].disk.rename('note.md', 'first-name.md');
	devices[1].disk.rename('note.md', 'second-name.md');
	for (const index of order) { await devices[index]!.open(); await sync(devices[index]!); }
	await converged({ 'first-name.md': 'original bytes\n', 'second-name.md': 'original bytes\n' });
});

it('preserves a new identical-byte incarnation from a third device with an old offline deletion', async () => {
	const [first, interrupted, stale] = await replicas('same bytes\n');
	stale.close(); stale.disk.remove('note.md');
	first.disk.remove('note.md'); await sync(first); await sync(interrupted);
	interrupted.disk.write('note.md', 'same bytes\n');
	const paused = interrupted.pauseNextUploadResponse();
	const syncing = interrupted.engine.sync();
	await paused.committed;
	interrupted.close(); await syncing;
	await stale.open(); await sync(stale);
	await interrupted.open(); await sync(interrupted);
	paused.release();
	await converged({ 'note.md': 'same bytes\n' });
});

it.each([false, true])('merges a restarted offline edit after changelog and remote ancestor expiry (local delete=%s)', async localDelete => {
	const original = '# Note\n\nAlpha\n\nBeta\n\nGamma\n';
	const [current, offline, third] = await replicas(original);
	offline.close();
	if (localDelete) offline.disk.remove('note.md');
	else offline.disk.write('note.md', original.replace('Beta', 'Beta edited offline'));
	for (let version = 0; version < 8; version++) {
		current.disk.write('note.md', original.replace('Alpha', `Alpha version ${version}`));
		await sync(current);
	}
	// Model a long disconnection at the durable retention boundary, without moving
	// the wall clock through token expiry or waiting thirty actual days.
	await env.DB.prepare("UPDATE changelog SET created_at = datetime('now', '-31 days')").run();
	await pruneChangelog(env.DB);
	await enqueueExpiredFileVersions(env.DB, Date.now() + 32 * 24 * 60 * 60_000);
	await drainObjectCleanupQueue(env.BUCKET, env.DB);
	expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM file_versions').first<{ n: number }>())!.n).toBe(0);
	await offline.open();
	const requestOffset = offline.requests.length;
	await sync(offline);
	expect(offline.requests.slice(requestOffset)).toContain('GET /sync/manifest');
	await sync(third);
	await converged({ 'note.md': original.replace('Alpha', 'Alpha version 7')
		.replace('Beta', localDelete ? 'Beta' : 'Beta edited offline') });
});

it.for([17, 2026, 91827])('conserves independent edits through seeded three-device restarts and lost responses (seed %i)',
	{ timeout: 120_000 }, async seed => {
		let state = seed;
		const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
		const lines = ['First initial', 'Second initial', 'Third initial'];
		const content = () => `# Shared\n\n${lines.join('\n\n')}\n`;
		const devices = await replicas(content());
		for (let round = 0; round < 12; round++) {
			const before = [...lines];
			for (let index = 0; index < devices.length; index++) {
				const client = devices[index]!;
				client.close();
				lines[index] = `Device ${index} round ${round} seed ${seed}`;
				client.disk.write('note.md', client.disk.text('note.md').replace(before[index]!, lines[index]!));
				await client.open();
			}
			const order = [0, 1, 2];
			for (let index = order.length - 1; index > 0; index--) {
				const swap = Math.floor(random() * (index + 1));
				[order[index], order[swap]] = [order[swap]!, order[index]!];
			}
			for (const index of order) {
				const client = devices[index]!;
				if (round % 4 === 0 && index === order[0]) {
					const pause = client.pauseNextUploadResponse();
					const pending = client.engine.sync();
					await pause.committed;
					client.close(); await pending;
					await client.open(); await sync(client);
					pause.release();
				} else await sync(client);
			}
			await converged({ 'note.md': content() });
		}
	});
