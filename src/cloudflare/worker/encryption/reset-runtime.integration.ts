/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUrlParam } from 'obsidian';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { SyncRuntime } from '../../../sync/runtime/runtime';
import { DEFAULT_SETTINGS } from '../../../plugin/settings-types';
import { SecretStorageService } from '../../../plugin/secret-storage';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { loadEncryptionReset } from '../../../sync/encryption/reset';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { SECRET_KEYS } from '../../../platform/secret-keys';
import { sha256Hex } from '@/platform/sha256';
import { loadEncryptionKeys } from '../../../sync/encryption/key-storage';
import { openFile } from '../../../encryption/file-codec';
import { readEncryptionState } from './state';

const bridge = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<typeof import('obsidian')>(), requestUrl: bridge }));
vi.mock('../../../ui/status', () => ({ StatusBarManager: class { update() {} destroy() {} } }));
let runtime: SyncRuntime;
const clients: SyncTestDevice[] = [];
let disk: PersistentTestVault;
let storage: SecretStorageService;
let state: EncryptionServerState;
let failSettings = false;
let disconnectedOrigin: string | undefined;
let loseBeginResponse = false;
let dropBeginRequest = false;
let revokeBeforeBegin = false;
let settings = structuredClone(DEFAULT_SETTINGS);
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
	settings = { ...structuredClone(DEFAULT_SETTINGS), workerUrl: 'https://old.trycloudflare.com', automaticSync: false, syncInterval: 0 };
	disk = new PersistentTestVault();
	const secrets = new Map<string, string>();
	storage = new SecretStorageService({ secretStorage: { getSecret: (key: string) => secrets.get(key), setSecret: (key: string, value: string) => secrets.set(key, value) } } as never, () => settings.workerUrl);
	storage.set(SECRET_KEYS.AUTH_TOKEN, 'original');
	const fixture = await createEncryptionFixture('active'), { bundle, recovery } = fixture;
	state = fixture.state;
	storage.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)); storage.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
	await env.DB.prepare('INSERT INTO server_state(id, encryption) VALUES (1, ?)').bind(JSON.stringify(state)).run();
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('original', ?, 'vault')").bind(await sha256Hex('original')).run();
	failSettings = false; disconnectedOrigin = undefined; loseBeginResponse = false; dropBeginRequest = false; revokeBeforeBegin = false;
	bridge.mockImplementation(async (options: RequestUrlParam) => {
		const url = new URL(options.url);
		if (url.origin === disconnectedOrigin) throw new Error('Tunnel is gone');
		if (failSettings && url.pathname === '/settings' && options.method === 'PUT') throw new Error('Settings response lost');
		if (dropBeginRequest && url.pathname === '/encryption/reset' && options.method === 'POST' && typeof options.body === 'string' && options.body.includes('delete-remote-data')) {
			dropBeginRequest = false;
			throw new Error('Begin request lost');
		}
		if (revokeBeforeBegin && url.pathname === '/encryption/reset' && options.method === 'POST') {
			revokeBeforeBegin = false;
			await env.DB.prepare('DELETE FROM auth_tokens').run();
		}
		const response = await worker.fetch(new Request(options.url, { method: options.method, body: options.body,
			headers: { ...options.headers, ...(options.contentType ? { 'Content-Type': options.contentType } : {}) },
		}), env);
		if (loseBeginResponse && url.pathname === '/encryption/reset' && options.method === 'POST' && response.ok) {
			loseBeginResponse = false;
			throw new Error('Begin response lost');
		}
		const arrayBuffer = await response.arrayBuffer();
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => { headers[key] = value; });
		return { status: response.status, headers, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
	});
	runtime = new SyncRuntime({ manifest: { dir: TEST_PLUGIN_DIR }, app: { vault: disk.vault, fileManager: {}, workspace: { layoutReady: true, onLayoutReady: () => {} } } } as never,
		settings, storage, async update => { Object.assign(settings, update); });
	await runtime.initialize();
});
afterEach(async () => {
	runtime?.destroy();
	for (const client of clients.splice(0)) { client.close(); await client.engine.waitForIdle(); }
	vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset();
});
const run = () => runtime.turnOffEncryption(state, () => {}, { workerUrl: settings.workerUrl, authToken: storage.get(SECRET_KEYS.AUTH_TOKEN)! });
async function secondDevice() {
	const client = new SyncTestDevice('reconnected-device', env); clients.push(client);
	await client.authorize(); await client.open();
	expect((await client.engine.sync()).success).toBe(true);
	return client;
}

it('preserves newer remote edits and additions when resuming after the settings save failed', async () => {
	disk.write('note.md', 'initial local copy\n');
	failSettings = true;
	await expect(run()).rejects.toThrow('shared settings');
	expect(loadEncryptionReset(storage)?.phase).toBe('upload');
	const other = await secondDevice();
	other.disk.write('note.md', 'new edit after the reset\n');
	other.disk.write('new.md', 'new file after the reset\n');
	expect((await other.engine.sync()).success).toBe(true);
	failSettings = false;
	await run();
	expect(loadEncryptionReset(storage)).toBeNull();
	for (const vault of [disk, other.disk]) {
		expect(vault.text('note.md')).toBe('new edit after the reset\n');
		expect(vault.text('new.md')).toBe('new file after the reset\n');
	}
	expect(new TextDecoder().decode((await other.api.downloadFile('note.md')).content)).toBe('new edit after the reset\n');
	expect(Object.keys((await other.api.getManifest()).files).sort()).toEqual(['new.md', 'note.md']);
});

it('syncs first so a server-only change survives turning encryption off', async () => {
	disk.write('note.md', 'local copy\n');
	expect((await runtime.sync()).success).toBe(true);
	const other = new SyncTestDevice('encrypted-device', env); clients.push(other);
	await other.authorize(); await other.open();
	await other.api.configureEncryption(loadEncryptionKeys(storage)!, () => ['Reminders'], () => 'Reading');
	other.disk.write('remote-only.md', 'only on the server\n');
	expect((await other.engine.sync()).success).toBe(true);
	const messages: string[] = [];
	await runtime.turnOffEncryption(state, message => { messages.push(message); }, { workerUrl: settings.workerUrl, authToken: storage.get(SECRET_KEYS.AUTH_TOKEN)! });
	expect(messages[0]).toBe('Syncing this device before replacing the server copy…');
	expect(loadEncryptionReset(storage)).toBeNull();
	// The server-only change reached this device before the wipe, so it was uploaded again.
	expect(disk.text('remote-only.md')).toBe('only on the server\n');
	const rows = (await env.DB.prepare('SELECT path, storage_key FROM files ORDER BY path').all<{ path: string; storage_key: string }>()).results;
	expect(rows.map(row => row.path)).toEqual(['note.md', 'remote-only.md']);
	expect(await (await env.BUCKET.get(rows[1]!.storage_key))!.text()).toBe('only on the server\n');
});

it('refuses to turn encryption off while this device has sync errors', async () => {
	await env.DB.prepare('DELETE FROM auth_tokens').run();
	await expect(run()).rejects.toThrow('Sync this device without errors or conflicts first');
	expect(loadEncryptionReset(storage)).toBeNull();
	expect(await readEncryptionState(env.DB)).toMatchObject({ mode: 'active' });
});

it('relocates an interrupted reset after the old tunnel disappears and resumes against the same receipt', async () => {
	disk.write('note.md', 'local copy\n'); failSettings = true;
	await expect(run()).rejects.toThrow('shared settings');
	const id = loadEncryptionReset(storage)!.id;
	disconnectedOrigin = settings.workerUrl;
	await runtime.updateEncryptionResetAddress('https://new.trycloudflare.com');
	expect(loadEncryptionReset(storage)?.id).toBe(id);
	failSettings = false;
	await run();
	expect(loadEncryptionReset(storage)).toBeNull();
	expect(disk.text('note.md')).toBe('local copy\n');
	expect((await env.DB.prepare("SELECT count(*) AS n FROM maintenance_state WHERE key LIKE 'encryption-reset:%'").first<{ n: number }>())!.n).toBe(1);
});

it('unblocks reconnect after the server rejects the first reset request with a revoked credential', async () => {
	revokeBeforeBegin = true;
	await expect(run()).rejects.toThrow('before it started');
	expect(loadEncryptionReset(storage)).toBeNull();
	expect(storage.get(SECRET_KEYS.ENCRYPTION_KEYS)).not.toBeNull();
	await runtime.clearSyncConfiguration();
	expect(settings.workerUrl).toBe('');
});

it('relocates after begin committed but its response was lost and the original token was revoked', async () => {
	disk.write('note.md', 'keep this vault\n'); loseBeginResponse = true;
	await expect(run()).rejects.toThrow('Begin response lost');
	const checkpoint = loadEncryptionReset(storage)!;
	expect(checkpoint.phase).toBe('remote');
	expect(checkpoint.beginState).toBe('attempted');
	expect(storage.get(SECRET_KEYS.AUTH_TOKEN)).toBe('original');
	expect(await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE id = 'original'").first()).toBeNull();
	disconnectedOrigin = settings.workerUrl;
	await runtime.updateEncryptionResetAddress('https://new.trycloudflare.com');
	await run();
	expect(loadEncryptionReset(storage)).toBeNull();
	expect(disk.text('note.md')).toBe('keep this vault\n');
	expect(storage.get(SECRET_KEYS.AUTH_TOKEN)).toBe(checkpoint.replacementToken);
});

describe('turning encryption on', () => {
	let setup: Awaited<ReturnType<typeof createEncryptionFixture>>;
	const messages: string[] = [];
	beforeEach(async () => {
		await env.DB.prepare('UPDATE server_state SET encryption = NULL WHERE id = 1').run();
		storage.delete(SECRET_KEYS.ENCRYPTION_KEYS); storage.delete(SECRET_KEYS.ENCRYPTION_RECOVERY);
		setup = await createEncryptionFixture('active');
		messages.length = 0;
		await runtime.initialize();
		// Leave plaintext history on the server.
		disk.write('note.md', 'first plaintext version\n');
		expect((await runtime.sync()).success).toBe(true);
		disk.write('note.md', 'current local version\n');
		expect((await runtime.sync()).success).toBe(true);
	});
	const turnOn = (bundle = setup.bundle, recovery = setup.recovery) => runtime.turnOnEncryption(bundle, recovery,
		message => { messages.push(message); }, { workerUrl: settings.workerUrl, authToken: storage.get(SECRET_KEYS.AUTH_TOKEN)! });
	/** The server holds exactly these files under tagged names, each sealed with the setup keys, and no plaintext anywhere. */
	async function expectEncryptedServer(files: Record<string, string>, retired: string[] = []) {
		expect(await readEncryptionState(env.DB)).toMatchObject({ mode: 'active', vaultId: setup.state.vaultId, generation: setup.state.generation,
			keyId: setup.state.keyId, notificationKeyId: setup.state.notificationKeyId, seal: setup.state.seal });
		const rows = (await env.DB.prepare('SELECT path, storage_key FROM files ORDER BY path').all<{ path: string; storage_key: string }>()).results;
		const plainByWire = new Map(await Promise.all(Object.keys(files).map(async path => [await setup.paths.wire(path), path] as const)));
		expect(rows.map(row => row.path).sort()).toEqual([...plainByWire.keys()].sort());
		for (const row of rows) {
			const bytes = new Uint8Array(await (await env.BUCKET.get(row.storage_key))!.arrayBuffer()), plain = plainByWire.get(row.path)!;
			expect(new TextDecoder().decode((await openFile(bytes, plain, setup.keys.forPath(row.path))).content)).toBe(files[plain]);
		}
		expect(await env.DB.prepare('SELECT 1 FROM file_versions').first()).toBeNull();
		const objects = await Promise.all((await env.BUCKET.list()).objects.map(async object => (await env.BUCKET.get(object.key))!.text()));
		for (const plaintext of [...Object.values(files), ...retired]) for (const object of objects) expect(object).not.toContain(plaintext.trim());
	}

	it('syncs first, wipes the server and leaves only this device’s vault, encrypted', async () => {
		const other = await secondDevice();
		other.disk.write('remote-only.md', 'only on the server\n');
		expect((await other.engine.sync()).success).toBe(true);
		disk.write('local-only.md', 'only on this device\n');
		await turnOn();
		expect(messages[0]).toBe('Syncing this device before replacing the server copy…');
		expect(messages.at(-1)).toBe('Encryption is on. Reconnect your other devices and web apps.');
		expect(loadEncryptionReset(storage)).toBeNull();
		expect(loadEncryptionKeys(storage)).toEqual(setup.bundle);
		expect(storage.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBe(setup.recovery);
		expect(storage.get(SECRET_KEYS.AUTH_TOKEN)).not.toBe('original');
		// The server-only change reached this device before the wipe.
		expect(disk.text('remote-only.md')).toBe('only on the server\n');
		const files = { 'local-only.md': 'only on this device\n', 'note.md': 'current local version\n', 'remote-only.md': 'only on the server\n' };
		await expectEncryptedServer(files, ['first plaintext version\n']);
		// Only the replacement credential of this device remains.
		const tokens = (await env.DB.prepare('SELECT token_hash FROM auth_tokens').all<{ token_hash: string }>()).results;
		expect(tokens).toEqual([{ token_hash: await sha256Hex(storage.get(SECRET_KEYS.AUTH_TOKEN)!) }]);
		// Ordinary sync continues with the new keys.
		disk.write('after.md', 'written after setup\n');
		const result = await runtime.sync();
		expect(result.errors).toEqual([]); expect(result.uploaded).toBe(1);
		await expectEncryptedServer({ ...files, 'after.md': 'written after setup\n' }, ['first plaintext version\n']);
	});

	it.each(['before begin reached the server', 'after begin committed but its response was lost', 'when the shared settings save failed'] as const)(
		'resumes a setup interrupted %s with the keys saved for it', async point => {
			if (point === 'before begin reached the server') dropBeginRequest = true;
			else if (point === 'after begin committed but its response was lost') loseBeginResponse = true;
			else failSettings = true;
			await expect(turnOn()).rejects.toThrow();
			expect(loadEncryptionReset(storage)).toMatchObject({ target: 'encrypted', vaultId: setup.bundle.vaultId,
				phase: point === 'when the shared settings save failed' ? 'upload' : 'remote' });
			expect(loadEncryptionKeys(storage)).toEqual(setup.bundle);
			failSettings = false;
			// A later request with other keys resumes the saved setup instead of starting another.
			const later = await createEncryptionFixture('active');
			await turnOn(later.bundle, later.recovery);
			expect(loadEncryptionReset(storage)).toBeNull();
			expect(loadEncryptionKeys(storage)).toEqual(setup.bundle);
			expect(messages.at(-1)).toBe('Encryption is on. Reconnect your other devices and web apps.');
			await expectEncryptedServer({ 'note.md': 'current local version\n' }, ['first plaintext version\n']);
		});

	it('refuses before the wipe when a synced file is nested deeper than an encrypted vault allows', async () => {
		const folder = Array.from({ length: 37 }, (_, index) => `f${index}`).join('/'), deep = `${folder}/deep.md`;
		await disk.vault.createFolder(folder); disk.write(deep, 'too deep to encrypt\n');
		await expect(turnOn()).rejects.toThrow(`1 file is nested more than 36 folders deep, which an encrypted vault cannot sync. Move it higher, then try again. First: ${deep}`);
		expect(loadEncryptionReset(storage)).toBeNull();
		expect(loadEncryptionKeys(storage)).toBeNull();
		expect(await readEncryptionState(env.DB)).toBeNull();
		expect(await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE id = 'original'").first()).not.toBeNull();
		expect((await env.DB.prepare('SELECT path FROM files ORDER BY path').all<{ path: string }>()).results.map(row => row.path)).toEqual([deep, 'note.md']);
	});

	it('releases a setup the server refuses to start and leaves the plaintext server untouched', async () => {
		await env.DB.prepare("INSERT INTO reading_policy VALUES (1,1,'Reading','reading-generation','revision')").run();
		await env.DB.prepare("INSERT INTO reading_captures(id,generation,url_identity,note,available_at) VALUES ('capture','reading-generation','private url','private note',0)").run();
		await expect(turnOn()).rejects.toThrow('Wait for saved links to finish downloading');
		expect(loadEncryptionReset(storage)).toBeNull();
		expect(await readEncryptionState(env.DB)).toBeNull();
		expect(storage.get(SECRET_KEYS.AUTH_TOKEN)).toBe('original');
		expect(await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE id = 'original'").first()).not.toBeNull();
		expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).not.toBeNull();
		const row = await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'note.md'").first<{ storage_key: string }>();
		expect(await (await env.BUCKET.get(row!.storage_key))!.text()).toBe('current local version\n');
		// The keys saved for the refused setup are gone, so later syncs stay plaintext.
		expect(loadEncryptionKeys(storage)).toBeNull();
		expect(storage.get(SECRET_KEYS.ENCRYPTION_RECOVERY)).toBeFalsy();
		runtime.destroy();
		runtime = new SyncRuntime({ manifest: { dir: TEST_PLUGIN_DIR }, app: { vault: disk.vault, fileManager: {}, workspace: { layoutReady: true, onLayoutReady: () => {} } } } as never,
			settings, storage, async update => { Object.assign(settings, update); });
		await runtime.initialize();
		disk.write('note.md', 'edited after the refusal\n');
		disk.write('new.md', 'created after the refusal\n');
		expect((await runtime.sync()).success).toBe(true);
		const rows = (await env.DB.prepare('SELECT path, storage_key FROM files ORDER BY path').all<{ path: string; storage_key: string }>()).results;
		expect(rows.map(file => file.path)).toEqual(['new.md', 'note.md']);
		expect(await (await env.BUCKET.get(rows[1]!.storage_key))!.text()).toBe('edited after the refusal\n');
	});
});
