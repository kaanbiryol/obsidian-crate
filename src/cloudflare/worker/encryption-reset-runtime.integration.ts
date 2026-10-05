/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RequestUrlParam } from 'obsidian';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { SyncRuntime } from '../../sync/runtime';
import { DEFAULT_SETTINGS, SECRET_KEYS } from '../../plugin/settings-types';
import { SecretStorageService } from '../../plugin/secret-storage';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { loadEncryptionReset } from '../../sync/encryption-reset';
import { sha256Hex } from './auth';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { SyncTestDevice } from './sync-engine-test-harness';

const bridge = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<typeof import('obsidian')>(), requestUrl: bridge }));
vi.mock('../../ui/status', () => ({ StatusBarManager: class { update() {} destroy() {} } }));
let runtime: SyncRuntime;
const clients: SyncTestDevice[] = [];
let disk: PersistentTestVault;
let storage: SecretStorageService;
let state: EncryptionServerState;
let failSettings = false;
let disconnectedOrigin: string | undefined;
let loseBeginResponse = false;
let settings = structuredClone(DEFAULT_SETTINGS);
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	settings = { ...structuredClone(DEFAULT_SETTINGS), workerUrl: 'https://old.trycloudflare.com', automaticSync: false, syncInterval: 0 };
	disk = new PersistentTestVault();
	const secrets = new Map<string, string>();
	storage = new SecretStorageService({ secretStorage: { getSecret: (key: string) => secrets.get(key), setSecret: (key: string, value: string) => secrets.set(key, value) } } as never, () => settings.workerUrl);
	storage.set(SECRET_KEYS.AUTH_TOKEN, 'original');
	const bundle = createVaultKeyBundle(), recovery = await generateRecoveryCode();
	state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, recovery)), mode: 'active' };
	storage.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)); storage.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
	await env.DB.prepare("INSERT INTO maintenance_state(key, value) VALUES ('e2ee:state', ?)").bind(JSON.stringify(state)).run();
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('original', ?, 'vault')").bind(await sha256Hex('original')).run();
	failSettings = false; disconnectedOrigin = undefined; loseBeginResponse = false;
	bridge.mockImplementation(async (options: RequestUrlParam) => {
		const url = new URL(options.url);
		if (url.origin === disconnectedOrigin) throw new Error('Tunnel is gone');
		if (failSettings && url.pathname === '/settings' && options.method === 'PUT') throw new Error('Settings response lost');
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
	await env.DB.prepare('DELETE FROM auth_tokens').run();
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
