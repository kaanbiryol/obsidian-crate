/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { vaultEntry } from '../../../sync/runtime/vault-event-gate';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
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
	else client.engine.onFileRename(vaultEntry(client.disk.vault.getAbstractFileByPath('renamed.md')!), 'original.md');
	if (mode === 'full' || mode === 'offline') client.settings.lastSeq = 0;
	const singleFail = vi.spyOn(client.files, 'uploadFile').mockImplementation(async path => ({ path, success: false, error: 'Storage unavailable', code: 'storage', status: 503 }));
	const fail = vi.spyOn(client.files, 'batchUpload').mockImplementation(async files => ({ success: false, results: files.map(file => ({ path: file.path, success: false, error: 'Storage unavailable', code: 'storage', status: 503 })) }));
	if (mode === 'queue') {
		// Flush the same event controller used by Obsidian, with its real queue.
		client.settings.automaticSync = true;
		client.settings.debounceDelay = 0;
		client.engine.onFileChange(vaultEntry(client.disk.vault.getAbstractFileByPath('renamed.md')!));
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

it.each([false, true])('moves files another device renamed instead of downloading them again (hidden: %s)', async hidden => {
	const [from, to] = hidden ? ['.config/old', '.config/new'] : ['Old', 'New'];
	const renamer = new SyncTestDevice(`renamer-${hidden}`, env), receiver = new SyncTestDevice(`receiver-${hidden}`, env);
	devices.push(renamer, receiver);
	for (const device of [renamer, receiver]) { await device.authorize(); await device.open(); }
	await renamer.disk.vault.adapter.mkdir(from);
	renamer.disk.write(`${from}/note.md`, 'Moved note');
	renamer.disk.write(`${from}/photo.bin`, new Uint8Array([1, 2, 3]).buffer);
	renamer.disk.write(`${from}/edited.md`, 'Before');
	expect((await renamer.engine.sync()).errors).toEqual([]);
	expect((await receiver.engine.sync()).errors).toEqual([]);
	expect(receiver.disk.text(`${from}/note.md`)).toBe('Moved note');
	// The receiver edits one file before the rename reaches it; that one is not moved.
	receiver.disk.write(`${from}/edited.md`, 'Edited on the receiver');
	await renamer.disk.vault.adapter.mkdir(to);
	for (const name of ['note.md', 'photo.bin', 'edited.md']) {
		renamer.disk.rename(`${from}/${name}`, `${to}/${name}`);
		if (!hidden) renamer.engine.onFileRename(vaultEntry(renamer.disk.vault.getAbstractFileByPath(`${to}/${name}`)!), `${from}/${name}`);
	}
	expect((await renamer.engine.sync()).errors).toEqual([]);
	receiver.requests.length = 0;
	const result = await receiver.engine.sync();
	expect(result.errors).toEqual([]);
	expect(receiver.disk.text(`${to}/note.md`)).toBe('Moved note');
	expect(new Uint8Array(receiver.disk.read(`${to}/photo.bin`))).toEqual(new Uint8Array([1, 2, 3]));
	expect(receiver.disk.has(`${from}/note.md`)).toBe(false);
	expect([...receiver.disk.trash.keys()]).not.toContain(`${from}/note.md`);
	// Only the file edited locally is downloaded; its edit is kept as a conflict or upload.
	const downloads = receiver.requests.filter(request => request.includes('download'));
	expect(downloads.join('\n')).not.toMatch(/note\.md|photo\.bin/);
	expect(receiver.checkpoint().files[`${to}/note.md`]).toMatchObject({ hash: renamer.checkpoint().files[`${to}/note.md`]!.hash });
	expect(receiver.checkpoint().files[`${from}/note.md`]).toBeUndefined();
	// Both devices converge on the same server state on the next round.
	expect((await receiver.engine.sync()).errors).toEqual([]);
	expect((await renamer.engine.sync()).errors).toEqual([]);
	expect(Object.keys((await renamer.api.getManifest()).files).filter(path => path.startsWith(to)).sort())
		.toEqual([`${to}/edited.md`, `${to}/note.md`, `${to}/photo.bin`]);
});
