/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { for (const device of devices.splice(0)) device.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

it.each(['full', 'incremental', 'offline', 'queue'])('preserves the original remote file after a failed %s rename and completes after restart', async mode => {
	const client = new SyncTestDevice(`rename-${mode}`, env); devices.push(client);
	await client.authorize(); await client.open();
	client.disk.write('original.md', 'Irreplaceable content');
	expect((await client.engine.sync()).errors).toEqual([]);
	await client.engine.sync();
	if (mode === 'offline') { client.close(); await client.engine.waitForIdle(); }
	client.disk.rename('original.md', 'renamed.md');
	client.disk.write('renamed.md', 'Irreplaceable content\nEdited after rename');
	if (mode === 'offline') await client.open();
	else client.engine.onFileRename(client.disk.vault.getAbstractFileByPath('renamed.md')!, 'original.md');
	if (mode === 'full' || mode === 'offline') client.settings.lastSeq = 0;
	const singleFail = vi.spyOn(client.api, 'uploadFile').mockImplementation(async path => ({ path, success: false, error: 'Storage unavailable', code: 'storage', status: 503 }));
	const fail = vi.spyOn(client.api, 'batchUpload').mockImplementation(async files => ({ success: false, results: files.map(file => ({ path: file.path, success: false, error: 'Storage unavailable', code: 'storage', status: 503 })) }));
	if (mode === 'queue') {
		// Flush the same event controller used by Obsidian, with its real queue.
		client.settings.debounceDelay = 0;
		client.engine.onFileChange(client.disk.vault.getAbstractFileByPath('renamed.md')!);
		await vi.waitFor(() => expect(client.engine.getState().status).toBe('error'));
	} else expect((await client.engine.sync()).errors.length).toBeGreaterThan(0);
	expect((await client.api.getManifest()).files['original.md']).toBeDefined();
	expect((await client.api.getManifest()).files['renamed.md']).toBeUndefined();
	client.close(); await client.engine.waitForIdle(); fail.mockRestore(); singleFail.mockRestore();
	await client.open();
	const retry = await client.engine.sync();
	expect(retry.errors).toEqual([]);
	const remote = await client.api.getManifest();
	expect(Object.keys(remote.files)).toEqual(['renamed.md']);
	expect(new TextDecoder().decode((await client.api.downloadFile('renamed.md')).content)).toBe('Irreplaceable content\nEdited after rename');
});
