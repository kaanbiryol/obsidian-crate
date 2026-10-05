/* eslint-disable @typescript-eslint/unbound-method -- Vitest spies on the engine prototype. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { WorkerApiHttpClient } from './worker-api/http';
import { SyncApiClient } from './api';
import { createRuntimeHarness, createDeferred } from './runtime-test-harness';
import { createEmptySyncResult, createSyncFailureResult } from './sync-result';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { SECRET_KEYS } from '../plugin/settings-types';
import type { EncryptionReset } from './encryption-reset';
import { loadEncryptionReset, EncryptionResetRejectedError } from './encryption-reset';

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
const remote = vi.hoisted(() => vi.fn<(_reset: EncryptionReset) => Promise<void>>(async () => {}));
vi.mock('./encryption-reset', async importOriginal => ({ ...await importOriginal<typeof import('./encryption-reset')>(), resetRemoteEncryption: remote }));
beforeEach(() => {
	remote.mockReset().mockResolvedValue(undefined);
	vi.spyOn(WorkerApiHttpClient.prototype, 'getServerInfo').mockResolvedValue({ service: 'crate', serverVersion: 'test', protocol: { current: 2, oldestCompatible: 2 }, capabilities: ['e2ee-reset-v1'] });
	vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
	vi.spyOn(SyncEngine.prototype, 'sync').mockResolvedValue(createEmptySyncResult());
	vi.spyOn(SyncEngine.prototype, 'forceFullSync').mockRejectedValue(new Error('Reset must never force overwrite'));
	vi.spyOn(SyncApiClient.prototype, 'putSharedSettings').mockResolvedValue({ success: true, settingsVersion: 'new' });
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
	const harness = createRuntimeHarness({ lastSeq: 500, lastSync: '2026-01-01' });
	const bundle = createVaultKeyBundle();
	const state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' as const };
	const values = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'auth-token'], [SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)], [SECRET_KEYS.ENCRYPTION_RECOVERY, 'old-recovery']]);
	harness.secretStorage.get.mockImplementation(key => values.get(key) ?? null);
	harness.secretStorage.has.mockImplementation((key: string) => values.has(key));
	harness.secretStorage.set.mockImplementation((key: string, value: string) => { values.set(key, value); });
	harness.secretStorage.delete.mockImplementation((key: string) => { values.delete(key); });
	harness.persistSettings.mockImplementation(async (update?: object) => { Object.assign(harness.settings, update); });
	const local = new Map([['local-note.md', 'keep this note'], [harness.plugin.manifest.dir + '/file-manifest.json', 'old checkpoint']]);
	harness.plugin.app.vault.adapter.exists.mockImplementation(async (path: string) => local.has(path));
	harness.plugin.app.vault.adapter.read.mockImplementation(async (path: string) => local.get(path));
	harness.plugin.app.vault.adapter.write.mockImplementation(async (path: string, value: string) => { local.set(path, value); });
	harness.plugin.app.vault.adapter.remove.mockImplementation(async (path: string) => { local.delete(path); });
	const run = () => harness.runtime.turnOffEncryption(state, () => {}, { workerUrl: harness.settings.workerUrl, authToken: values.get(SECRET_KEYS.AUTH_TOKEN)! });
	return { ...harness, values, state, local, run };
}

it('keeps local notes, replaces credentials and sync state, then uploads without encryption', async () => {
	const h = await setup();
	try {
		await h.run();
		expect(h.local.get('local-note.md')).toBe('keep this note');
		expect(h.local.has(h.plugin.manifest.dir + '/file-manifest.json')).toBe(false);
		expect(h.values.get(SECRET_KEYS.AUTH_TOKEN)).toMatch(/^[a-f0-9]{64}$/);
		for (const key of [SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY, SECRET_KEYS.ENCRYPTION_RESET]) expect(h.values.has(key)).toBe(false);
		expect(h.settings.lastSeq).toBe(0);
		expect(h.settings.automaticSync).toBe(true);
		expect(SyncEngine.prototype.sync).toHaveBeenCalledOnce();
		expect(SyncEngine.prototype.forceFullSync).not.toHaveBeenCalled();
	} finally { h.runtime.destroy(); }
});

it('blocks startup and ordinary sync after failure, and resumes only the unfinished upload', async () => {
	const h = await setup();
	vi.mocked(SyncEngine.prototype.sync).mockResolvedValueOnce(createSyncFailureResult('Disconnected'));
	try {
		await expect(h.run()).rejects.toThrow('uploading needs attention');
		expect(loadEncryptionReset(h.secretStorage as never)?.phase).toBe('upload');
		expect(h.settings.automaticSync).toBe(false);
		await h.runtime.initialize();
		expect(h.runtime.getApiClient()).toBeNull();
		expect((await h.runtime.sync()).success).toBe(false);
		await expect(h.runtime.clearSyncConfiguration()).rejects.toThrow('before disconnecting');
		const removals = h.plugin.app.vault.adapter.remove.mock.calls.length;
		await h.run();
		expect(remote).toHaveBeenCalledOnce();
		expect(h.plugin.app.vault.adapter.remove.mock.calls).toHaveLength(removals);
		expect(h.local.get('local-note.md')).toBe('keep this note');
	} finally { h.runtime.destroy(); }
});

it('retains the resume checkpoint and old keys when the server response is lost', async () => {
	const h = await setup();
	remote.mockRejectedValueOnce(new Error('Lost response'));
	try {
		await expect(h.run()).rejects.toThrow('Lost response');
		expect(loadEncryptionReset(h.secretStorage as never)?.phase).toBe('remote');
		expect(h.values.get(SECRET_KEYS.AUTH_TOKEN)).toBe('auth-token');
		expect(h.values.has(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(true);
		expect(h.plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
		await h.run();
		expect(remote.mock.calls[0]?.[0]).toEqual(remote.mock.calls[1]?.[0]);
	} finally { h.runtime.destroy(); }
});

it('does not resume initialization or local deletion after the runtime is stopped', async () => {
	const h = await setup(), pending = createDeferred<void>();
	remote.mockReturnValueOnce(pending.promise);
	const run = h.run();
	await vi.waitFor(() => expect(remote).toHaveBeenCalled());
	h.runtime.destroy(); pending.resolve();
	await expect(run).rejects.toMatchObject({ name: 'AbortError' });
	expect(h.plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
	expect(h.values.has(SECRET_KEYS.ENCRYPTION_RESET)).toBe(true);
});

it('keeps the upload checkpoint when shutdown interrupts reset initialization', async () => {
	const h = await setup(), initialized = createDeferred<void>();
	vi.mocked(SyncEngine.prototype.initialize).mockReturnValueOnce(initialized.promise);
	const running = h.run();
	await vi.waitFor(() => expect(SyncEngine.prototype.initialize).toHaveBeenCalled());
	h.runtime.destroy();
	initialized.resolve();
	await expect(running).rejects.toMatchObject({ name: 'AbortError' });
	expect(SyncEngine.prototype.sync).not.toHaveBeenCalled();
	expect(loadEncryptionReset(h.secretStorage as never)?.phase).toBe('upload');
	expect(h.settings.automaticSync).toBe(false);
	expect(h.runtime.getApiClient()).toBeNull();
});

it('leaves sync and credentials intact when the server does not support reset', async () => {
	const h = await setup();
	vi.mocked(WorkerApiHttpClient.prototype.getServerInfo).mockResolvedValue({ service: 'crate', serverVersion: 'old', protocol: { current: 2, oldestCompatible: 2 }, capabilities: ['e2ee-v1'] });
	const destroy = vi.spyOn(h.runtime, 'destroy');
	await expect(h.run()).rejects.toThrow('Update your Crate server');
	expect(h.values.has(SECRET_KEYS.ENCRYPTION_RESET)).toBe(false);
	expect(h.values.has(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(true);
	expect(h.settings.automaticSync).toBe(true);
	expect(destroy).not.toHaveBeenCalled();
	expect(remote).not.toHaveBeenCalled();
});

it('does not start a reset after being stopped during the server capability check', async () => {
	const h = await setup();
	const probe = createDeferred<Awaited<ReturnType<WorkerApiHttpClient['getServerInfo']>>>();
	vi.mocked(WorkerApiHttpClient.prototype.getServerInfo).mockReturnValueOnce(probe.promise);
	const running = h.run();
	await vi.waitFor(() => expect(WorkerApiHttpClient.prototype.getServerInfo).toHaveBeenCalled());
	h.runtime.destroy();
	probe.resolve({ service: 'crate', serverVersion: 'new', protocol: { current: 2, oldestCompatible: 2 }, capabilities: ['e2ee-reset-v1'] });
	await expect(running).rejects.toMatchObject({ name: 'AbortError' });
	expect(h.values.has(SECRET_KEYS.ENCRYPTION_RESET)).toBe(false);
	expect(remote).not.toHaveBeenCalled();
});

it('releases a definitively rejected start so the device can disconnect and reconnect', async () => {
	const h = await setup();
	remote.mockRejectedValueOnce(new EncryptionResetRejectedError());
	await expect(h.run()).rejects.toThrow('before it started');
	expect(h.values.has(SECRET_KEYS.ENCRYPTION_RESET)).toBe(false);
	expect(h.values.has(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(true);
	expect(h.values.get(SECRET_KEYS.AUTH_TOKEN)).toBe('auth-token');
	expect(h.settings.automaticSync).toBe(true);
	expect(h.plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
	await h.runtime.clearSyncConfiguration();
	await h.runtime.applyInfrastructureConfig({ workerUrl: h.settings.workerUrl || 'https://worker.example', authToken: 'new-device-token' });
	expect(h.runtime.getApiClient()).not.toBeNull();
	h.runtime.destroy();
});

it('reconciles again after only the shared settings save failed, without force uploading', async () => {
	const h = await setup();
	vi.mocked(SyncApiClient.prototype.putSharedSettings).mockRejectedValueOnce(new Error('Offline'));
	try {
		await expect(h.run()).rejects.toThrow('shared settings');
		expect(loadEncryptionReset(h.secretStorage as never)?.phase).toBe('upload');
		await h.run();
		expect(remote).toHaveBeenCalledOnce();
		expect(SyncEngine.prototype.sync).toHaveBeenCalledTimes(2);
		expect(SyncEngine.prototype.forceFullSync).not.toHaveBeenCalled();
	} finally { h.runtime.destroy(); }
});

/* eslint-enable @typescript-eslint/unbound-method -- End of prototype-spy tests. */
