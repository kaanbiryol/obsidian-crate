/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { createVaultKeyBundle, addReminderScope, generateRecoveryCode, sealRecoveryBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';
import { ENCRYPTION_STATE_KEY } from './encryption-state';
import { SyncWorkerApi } from '../../sync/worker-api/sync';

const devices: SyncTestDevice[] = [];
let bundle: VaultKeyBundle;
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	state.mode = 'active';
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
});
afterEach(async () => {
	for (const device of devices.splice(0)) device.close();
	vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});

async function open(device: SyncTestDevice) {
	await device.open();
	await device.api.configureEncryption(bundle);
}
async function device(id: string) {
	const result = new SyncTestDevice(id, env); devices.push(result);
	await result.authorize(3600_000); await open(result); return result;
}
async function sync(device: SyncTestDevice) {
	const result = await device.engine.sync();
	expect(result.errors, `${device.id}: ${JSON.stringify(result)}`).toEqual([]);
	expect(result.success).toBe(true); return result;
}
async function replicas(path: string, content: string | ArrayBuffer) {
	const first = await device('first'); first.disk.write(path, content); await sync(first);
	const second = await device('second'), third = await device('third');
	await sync(second); await sync(third); await sync(first);
	return [first, second, third] as const;
}
async function converge(clients: readonly SyncTestDevice[], files: Record<string, string>) {
	for (const client of clients) await sync(client);
	for (const client of clients) {
		expect(client.disk.paths()).toEqual(Object.keys(files).sort());
		for (const [path, text] of Object.entries(files)) expect(client.disk.text(path)).toBe(text);
	}
}

it('merges encrypted offline edits across three restarted clients using plaintext merge bases', async () => {
	const original = '# Shared\n\nAlpha\n\nBeta\n\nGamma\n';
	const clients = await replicas('note.md', original);
	for (const client of clients) client.close();
	for (const [index, label] of ['Alpha', 'Beta', 'Gamma'].entries()) {
		const client = clients[index]!; client.disk.write('note.md', original.replace(label, `${label} changed`));
		await open(client); await sync(client);
	}
	await converge(clients, { 'note.md': '# Shared\n\nAlpha changed\n\nBeta changed\n\nGamma changed\n' });
	const stored = await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'note.md'").first<{ storage_key: string }>();
	expect(await (await env.BUCKET.get(stored!.storage_key))!.text()).not.toContain('Alpha changed');
});

it.each(['sync', 'selected', 'wire-fallback'])('reconciles encrypted edits made after planning while uploading other files (%s)', async mode => {
	// Below the plaintext batch limit but above it after encryption framing.
	const original = '# Note\n\nAlpha.\n\nBeta.\n' + (mode === 'wire-fallback' ? 'x'.repeat(800 * 1024) : '');
	const first = await device('selected-first');
	first.disk.write('note.md', original); first.disk.write('other.md', 'Original'); await sync(first);
	const rival = await device('selected-rival'); await sync(rival);
	first.disk.write('note.md', original.replace('Alpha.', 'Local alpha.'));
	first.disk.write('other.md', 'Unrelated local edit');
	for (const path of ['note.md', 'other.md']) first.engine.onFileChange({ path } as never);
	const editRemotely = async () => {
		rival.disk.write('note.md', original.replace('Beta.', 'Remote beta.'));
		await sync(rival);
	};
	if (mode === 'selected') {
		const metadata = first.api.getFileMetadata.bind(first.api);
		vi.spyOn(first.api, 'getFileMetadata').mockImplementationOnce(async paths => {
			const previous = await metadata(paths); await editRemotely(); return previous;
		});
	} else if (mode === 'wire-fallback') {
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Reapplied to the intercepted instance below.
		const upload = SyncWorkerApi.prototype.uploadFile;
		vi.spyOn(SyncWorkerApi.prototype, 'uploadFile').mockImplementationOnce(async function (this: SyncWorkerApi, ...args) {
			await editRemotely(); return upload.apply(this, args);
		});
	} else {
		const upload = first.files.batchUpload.bind(first.files);
		vi.spyOn(first.files, 'batchUpload').mockImplementationOnce(async files => {
			await editRemotely(); return upload(files);
		});
	}
	const result = await (mode === 'selected' ? first.engine.syncSelected(['note.md', 'other.md']) : first.engine.sync());
	expect(result).toMatchObject({ success: true, merged: 1, uploaded: 1, errors: [] });
	if (mode === 'wire-fallback') expect(first.requests).toContain('PUT /sync/upload');
	expect((await first.engine.sync())).toMatchObject({ success: true, uploaded: 0, merged: 0, errors: [] });
	await converge([first, rival], { 'note.md': original.replace('Alpha.', 'Local alpha.').replace('Beta.', 'Remote beta.'), 'other.md': 'Unrelated local edit' });
});

it('adopts encrypted server settings on an empty vault first sync without uploading its setup defaults', async () => {
  const first = await device('first'), path = '.obsidian/appearance.json';
  first.disk.write(path, '{"theme":"private-vault-theme"}'); first.disk.write('note.md', 'Private note'); await sync(first);
  const before = await first.api.getManifest();
  const second = await device('empty-vault');
  second.disk.write(path, '{"theme":"new-vault-default"}'); await second.engine.onRawFileChange(path);
  const pulled = await sync(second);
  expect(pulled.uploaded).toBe(0); expect(pulled.conflicts).toEqual([]);
  expect(second.disk.text(path)).toBe('{"theme":"private-vault-theme"}');
  expect((await first.api.getManifest()).files).toEqual(before.files);
  const stored = await env.DB.prepare('SELECT storage_key FROM files WHERE path=?').bind(path).first<{ storage_key: string }>();
  expect(await (await env.BUCKET.get(stored!.storage_key))!.text()).not.toContain('private-vault-theme');
});

it('decrypts retained baselines and shared history when comparing unsynced local settings', async () => {
  const first = await device('first'), path = '.obsidian/appearance.json';
  const original = '{"theme":"original private setting"}', local = '{"theme":"local unsynced setting"}';
  first.disk.write(path, original); await sync(first);
  const checkpoint = await first.engine.saveSharedHistoryCheckpoint(); expect(checkpoint).toBeDefined();
  const second = await device('second'); await sync(second);
  second.disk.write(path, '{"theme":"new remote setting"}'); await sync(second);
  first.disk.write(path, local); await first.engine.onRawFileChange(path);
  expect(await first.engine.loadPendingDiff(path, false)).toMatchObject({ before: original, after: local });
  const comparison = await first.engine.loadHistoryComparison(checkpoint!.id, true);
  expect(comparison.items).toContainEqual({ path, action: 'modified' });
  expect(await comparison.preview(path)).toEqual({ current: local, saved: original });
  expect(first.disk.text(path)).toBe(local);
});

it.each(['delete-first', 'edit-first'])('preserves encrypted offline edits in delete races (%s)', async order => {
	const clients = await replicas('note.md', 'original\n'), [deleting, editing] = clients;
	deleting.close(); editing.close(); deleting.disk.remove('note.md'); editing.disk.write('note.md', 'edited offline\n');
	await open(deleting); await open(editing);
	for (const client of order === 'delete-first' ? [deleting, editing] : [editing, deleting]) await sync(client);
	await converge(clients, { 'note.md': 'edited offline\n' });
});

it('renames across vault and reminder key scopes without losing either concurrent copy', async () => {
	const clients = await replicas('note.md', 'original\n'), [renaming, editing] = clients;
	await renaming.disk.vault.createFolder('Reminders');
	renaming.close(); editing.close(); renaming.disk.rename('note.md', 'Reminders/renamed.md'); editing.disk.write('note.md', 'edited while offline\n');
	await open(renaming); await open(editing); await sync(renaming); await sync(editing);
	await converge(clients, { 'note.md': 'edited while offline\n', 'Reminders/renamed.md': 'original\n' });
});

it('settles an encrypted upload committed before restart without publishing fresh ciphertext', async () => {
	const clients = await replicas('note.md', 'original\n'), [interrupted, observer] = clients;
	interrupted.disk.write('note.md', 'committed before disconnect\n');
	const paused = interrupted.pauseNextUploadResponse();
	try {
		const syncing = interrupted.engine.sync(); await paused.committed; interrupted.close(); await syncing;
		expect(new TextDecoder().decode((await observer.api.downloadFile('note.md')).content)).toBe('committed before disconnect\n');
		const before = await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'note.md'").first();
		await open(interrupted); await sync(interrupted);
		expect(await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'note.md'").first()).toEqual(before);
		paused.release(); await converge(clients, { 'note.md': 'committed before disconnect\n' });
	} finally { paused.release(); }
});

it('preserves both conflicting encrypted binary versions across retries', async () => {
	const clients = await replicas('image.bin', new Uint8Array([0, 1]).buffer), [first, second] = clients;
	first.disk.write('image.bin', new Uint8Array([0, 2]).buffer); second.disk.write('image.bin', new Uint8Array([0, 3]).buffer);
	await sync(first);
	const result = await second.engine.sync();
	expect(result.success).toBe(false);
	const copy = second.disk.paths().find(path => path !== 'image.bin'); expect(copy).toBeDefined();
	expect(new Uint8Array(second.disk.read(copy!))).toEqual(new Uint8Array([0, 2]));
	expect(new Uint8Array(second.disk.read('image.bin'))).toEqual(new Uint8Array([0, 3]));
	await second.engine.sync();
	expect(second.disk.paths()).toEqual([copy!, 'image.bin'].sort());
	expect(second.engine.getActiveConflicts()).toHaveLength(1);
});

it('round-trips an encrypted attachment at the 25 MiB plaintext limit', async () => {
	const content = new Uint8Array(25 * 1024 * 1024);
	for (let index = 0; index < content.length; index++) content[index] = index % 251;
	const first = await device('large-first');
	first.disk.write('large.bin', content.buffer); await sync(first);
	const second = await device('large-second'); await sync(second);
	expect(second.disk.read('large.bin')).toEqual(content.buffer);
	const metadata = await env.DB.prepare("SELECT size FROM files WHERE path = 'large.bin'").first<{ size: number }>();
	expect(metadata!.size).toBeGreaterThan(content.length);
}, 30_000); // Two-device encryption and transfer of 25 MiB is a correctness check, not a 5-second benchmark.

it('preserves encrypted file renames and moves across folder keys on another device', async () => {
  const first = await device('move-first'), second = await device('move-second');
  await first.disk.vault.adapter.mkdir('Reminders');
  first.disk.write('Reminders/Original.md', 'Private movable note');
  await sync(first); await sync(second);
  first.disk.rename('Reminders/Original.md', 'Moved.md');
  first.engine.onFileRename(first.disk.vault.getAbstractFileByPath('Moved.md')!, 'Reminders/Original.md');
  await sync(first); await sync(second);
  expect(second.disk.paths()).toEqual(['Moved.md']);
  expect(second.disk.text('Moved.md')).toBe('Private movable note');
  first.disk.rename('Moved.md', 'Reminders/Renamed.md');
  first.engine.onFileRename(first.disk.vault.getAbstractFileByPath('Reminders/Renamed.md')!, 'Moved.md');
  await sync(first); await sync(second);
  expect(second.disk.paths()).toEqual(['Reminders/Renamed.md']);
  expect(second.disk.text('Reminders/Renamed.md')).toBe('Private movable note');
});

it('syncs a renamed enrolled folder without resurrecting its old path', async () => {
  const first = await device('folder-first'), second = await device('folder-second');
  await first.disk.vault.adapter.mkdir('Reminders');
  first.disk.write('Reminders/Inbox.md', 'Private moved folder content'); await sync(first); await sync(second);
  await first.disk.vault.adapter.mkdir('Tasks');
  first.disk.rename('Reminders/Inbox.md', 'Tasks/Inbox.md');
  first.engine.onFileRename({ path: 'Tasks' } as never, 'Reminders');
  first.close(); await first.engine.waitForIdle();
  const { moveEncryptionScopes } = await import('../../encryption/key-bundle');
  const { convertEncryptedVault } = await import('../../sync/encryption-conversion');
  const { WorkerApiHttpClient } = await import('../../sync/worker-api/http');
  const worker = (await import('./index')).default;
  const recovery = await generateRecoveryCode();
  const http = new WorkerApiHttpClient('https://worker.test', first.id, async input => {
    const response = await worker.fetch(new Request(input.url, { method: input.method, body: input.body, headers: { ...input.headers,
      ...(input.contentType ? { 'Content-Type': input.contentType } : {}) } }), env);
    const bytes = await response.arrayBuffer();
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
  });
  bundle = moveEncryptionScopes(bundle, 'Reminders', 'Tasks');
  await convertEncryptedVault(http, bundle, recovery, () => {});
  await open(first); await sync(first);
  await second.api.configureEncryption(bundle); await sync(second);
  await converge([first, second], { 'Tasks/Inbox.md': 'Private moved folder content' });
});
