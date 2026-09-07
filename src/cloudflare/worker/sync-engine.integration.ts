/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	for (const sql of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => {
	for (const device of devices.splice(0)) device.close();
	vi.unstubAllGlobals();
	await reset();
});

async function device(id: string): Promise<SyncTestDevice> {
	const result = new SyncTestDevice(id, env);
	devices.push(result);
	await result.authorize();
	await result.open();
	return result;
}

async function sync(device: SyncTestDevice) {
	const result = await device.engine.sync();
	expect(result.errors, `${device.id}: ${JSON.stringify(result)}`).toEqual([]);
	expect(result.success).toBe(true);
	return result;
}

async function replicas(path: string, content: string | ArrayBuffer) {
	const first = await device('first');
	first.disk.write(path, content);
	await sync(first);
	const second = await device('second');
	const third = await device('third');
	await sync(second);
	await sync(third);
	await sync(first);
	return [first, second, third] as const;
}

async function expectConvergence(replicas: readonly SyncTestDevice[], expected: Record<string, string>) {
	for (const replica of replicas) await sync(replica);
	for (const replica of replicas) {
		expect(replica.disk.paths()).toEqual(Object.keys(expected).sort());
		expect(Object.keys(replica.checkpoint().files).sort()).toEqual(Object.keys(expected).sort());
		for (const [path, content] of Object.entries(expected)) expect(replica.disk.text(path)).toBe(content);
	}
	const remote = await replicas[0]!.api.getManifest();
	expect(Object.keys(remote.files).sort()).toEqual(Object.keys(expected).sort());
	for (const [path, content] of Object.entries(expected)) {
		expect(new TextDecoder().decode((await replicas[0]!.api.downloadFile(path)).content)).toBe(content);
	}
}

describe('multiple real sync engines across Worker and storage boundaries', () => {
	it('retains literal prototype filenames across client synchronization and checkpoint restart', async () => {
		const first = await device('first');
		for (const path of ['__proto__', 'constructor', 'toString']) first.disk.write(path, `content:${path}`);
		await sync(first);
		const second = await device('second');
		await sync(second);
		second.close();
		await second.open();
		await expectConvergence([first, second], {
			['__proto__']: 'content:__proto__', constructor: 'content:constructor', toString: 'content:toString',
		});
		first.disk.remove('__proto__');
		await sync(first);
		await expectConvergence([first, second], { constructor: 'content:constructor', toString: 'content:toString' });
	});

	it('merges disconnected edits from three restarted devices and converges', async () => {
		const original = '# Shared\n\nAlpha\n\nBeta\n\nGamma\n';
		const clients = await replicas('note.md', original);
		for (const client of clients) client.close();
		clients[0].disk.write('note.md', original.replace('Alpha', 'Alpha from first'));
		clients[1].disk.write('note.md', original.replace('Beta', 'Beta from second'));
		clients[2].disk.write('note.md', original.replace('Gamma', 'Gamma from third'));
		const merged = [];
		for (const client of clients) {
			await client.open();
			merged.push((await sync(client)).merged);
		}
		expect(merged).toEqual([0, 1, 1]);
		await expectConvergence(clients, {
			'note.md': '# Shared\n\nAlpha from first\n\nBeta from second\n\nGamma from third\n',
		});
	});

	it.each(['delete-first', 'edit-first'])('preserves an offline edit through an edit/delete race (%s)', async order => {
		const clients = await replicas('note.md', 'original\n');
		const [deleting, editing] = clients;
		deleting.close();
		editing.close();
		deleting.disk.remove('note.md');
		editing.disk.write('note.md', 'edited offline\n');
		await deleting.open();
		await editing.open();
		for (const client of order === 'delete-first' ? [deleting, editing] : [editing, deleting]) await sync(client);
		await expectConvergence(clients, { 'note.md': 'edited offline\n' });
	});

	it('retains the renamed copy and concurrent edits at the original path', async () => {
		const clients = await replicas('note.md', 'original\n');
		const [renaming, editing] = clients;
		renaming.close();
		editing.close();
		renaming.disk.rename('note.md', 'renamed.md');
		editing.disk.write('note.md', 'edited original while offline\n');
		await renaming.open();
		await editing.open();
		await sync(renaming);
		await sync(editing);
		await expectConvergence(clients, {
			'note.md': 'edited original while offline\n', 'renamed.md': 'original\n',
		});
	});

	it('recovers a committed upload after interruption and ignores its late response after restart', async () => {
		const clients = await replicas('note.md', 'original\n');
		const [interrupted, observer] = clients;
		const previousCheckpoint = interrupted.checkpoint();
		interrupted.disk.write('note.md', 'committed before the connection stopped\n');
		const paused = interrupted.pauseNextUploadResponse();
		const syncing = interrupted.engine.sync();
		await paused.committed;
		interrupted.close();
		await syncing;
		expect(interrupted.checkpoint()).toEqual(previousCheckpoint);
		expect(new TextDecoder().decode((await observer.api.downloadFile('note.md')).content))
			.toBe('committed before the connection stopped\n');
		await interrupted.open();
		await sync(interrupted);
		const resumedCheckpoint = interrupted.checkpoint();
		paused.release();
		await Promise.resolve();
		await expectConvergence(clients, { 'note.md': 'committed before the connection stopped\n' });
		expect(interrupted.checkpoint()).toEqual(resumedCheckpoint);
	});

	it('keeps both byte sequences and one review copy when binary edits conflict across retries', async () => {
		const clients = await replicas('image.bin', new Uint8Array([0, 1]).buffer);
		const [first, second] = clients;
		first.disk.write('image.bin', new Uint8Array([0, 2]).buffer);
		second.disk.write('image.bin', new Uint8Array([0, 3]).buffer);
		await sync(first);
		const result = await second.engine.sync();
		expect(result.success).toBe(false);
		expect(result.errors.some(error => error.includes('Incoming file saved'))).toBe(true);
		const copy = second.disk.paths().find(path => path !== 'image.bin');
		expect(copy).toBeDefined();
		expect(new Uint8Array(second.disk.read('image.bin'))).toEqual(new Uint8Array([0, 3]));
		expect(new Uint8Array(second.disk.read(copy!))).toEqual(new Uint8Array([0, 2]));
		await second.engine.sync();
		expect(second.disk.paths()).toEqual([copy!, 'image.bin'].sort());
		expect(second.engine.getActiveConflicts()).toHaveLength(1);
		expect(new Uint8Array((await first.api.downloadFile('image.bin')).content)).toEqual(new Uint8Array([0, 2]));
	});
});
