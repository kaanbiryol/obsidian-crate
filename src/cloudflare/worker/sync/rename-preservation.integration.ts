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

it.each(['incremental', 'offline', 'queue'])('moves a renamed folder on the server without uploading it again (%s)', async mode => {
	const renamer = new SyncTestDevice(`folder-${mode}`, env), receiver = new SyncTestDevice(`folder-receiver-${mode}`, env);
	devices.push(renamer, receiver);
	for (const device of [renamer, receiver]) { await device.authorize(); await device.open(); }
	await renamer.disk.vault.adapter.mkdir('Old');
	const names = Array.from({ length: 100 }, (_, index) => `note ${index}.md`);
	for (const name of names) renamer.disk.write(`Old/${name}`, `Body of ${name}`);
	expect((await renamer.engine.sync()).errors).toEqual([]);
	expect((await receiver.engine.sync()).errors).toEqual([]);
	const revisions = Object.fromEntries(names.map(name => [name, renamer.checkpoint().files[`Old/${name}`]!.revision]));

	if (mode === 'offline') { renamer.close(); await renamer.engine.waitForIdle(); }
	await renamer.disk.vault.adapter.mkdir('New');
	renamer.requests.length = 0;
	for (const name of names) {
		renamer.disk.rename(`Old/${name}`, `New/${name}`);
		if (mode !== 'offline') renamer.engine.onFileRename(vaultEntry(renamer.disk.vault.getAbstractFileByPath(`New/${name}`)!), `Old/${name}`);
	}
	if (mode === 'queue') {
		renamer.settings.automaticSync = true;
		renamer.settings.debounceDelay = 0;
		renamer.engine.onFileChange(vaultEntry(renamer.disk.vault.getAbstractFileByPath(`New/${names[0]}`)!));
		await vi.waitFor(async () => expect(Object.keys((await renamer.api.getManifest()).files).filter(path => path.startsWith('Old/'))).toEqual([]), { timeout: 10_000 });
		await renamer.engine.waitForIdle();
	} else {
		if (mode === 'offline') await renamer.open();
		expect((await renamer.engine.sync()).errors).toEqual([]);
	}
	expect(renamer.requests.filter(request => request.includes('/sync/batch-move'))).toHaveLength(Math.ceil(names.length / 32));
	expect(renamer.requests.filter(request => /\/sync\/(batch-)?upload|\/sync\/batch-delete/.test(request))).toEqual([]);
	const remote = await renamer.api.getManifest();
	expect(Object.keys(remote.files).sort()).toEqual(names.map(name => `New/${name}`).sort());
	for (const name of names) expect(remote.files[`New/${name}`]!.revision).toBe(revisions[name]);

	receiver.requests.length = 0;
	expect((await receiver.engine.sync()).errors).toEqual([]);
	expect(receiver.requests.filter(request => request.includes('download'))).toEqual([]);
	for (const name of names) expect(receiver.disk.text(`New/${name}`)).toBe(`Body of ${name}`);
	expect(receiver.disk.has(`Old/${names[0]}`)).toBe(false);
	// Nothing is left to send on either device.
	renamer.requests.length = 0;
	expect((await renamer.engine.sync()).errors).toEqual([]);
	expect(renamer.requests.filter(request => request.startsWith('POST') || request.startsWith('PUT'))).toEqual([]);
});

it('records a move whose response was lost, even after the file is renamed again', async () => {
	const renamer = new SyncTestDevice('lost-move', env), receiver = new SyncTestDevice('lost-move-receiver', env);
	devices.push(renamer, receiver);
	for (const device of [renamer, receiver]) { await device.authorize(); await device.open(); }
	renamer.disk.write('a.md', 'Renamed twice');
	expect((await renamer.engine.sync()).errors).toEqual([]);
	expect((await receiver.engine.sync()).errors).toEqual([]);

	// The server makes the move, but its response never arrives.
	const send = renamer.files.batchMove;
	const lost = vi.spyOn(renamer.files, 'batchMove').mockImplementation(async moves => { await send(moves); throw new TypeError('Failed to fetch'); });
	renamer.disk.rename('a.md', 'b.md');
	expect((await renamer.engine.sync()).errors.length).toBeGreaterThan(0);
	lost.mockRestore();
	expect(Object.keys((await renamer.api.getManifest()).files)).toEqual(['b.md']);

	renamer.disk.rename('b.md', 'c.md');
	renamer.requests.length = 0;
	expect((await renamer.engine.sync()).errors).toEqual([]);
	expect(renamer.requests.filter(request => /\/sync\/(batch-)?upload/.test(request))).toEqual([]);
	expect((await receiver.engine.sync()).errors).toEqual([]);
	for (const device of [renamer, receiver]) {
		expect(device.disk.paths()).toEqual(['c.md']);
		expect(device.disk.text('c.md')).toBe('Renamed twice');
	}
	expect(Object.keys((await renamer.api.getManifest()).files)).toEqual(['c.md']);
});
