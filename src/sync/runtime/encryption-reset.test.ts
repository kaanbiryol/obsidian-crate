/* eslint-disable @typescript-eslint/unbound-method -- Vitest spies on the engine prototype. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncEngine } from '../engine/engine';
import { WorkerApiHttpClient } from '../worker-api/http';
import { SyncApiClient } from '../worker-api/client';
import { createRuntimeHarness, createDeferred } from './runtime-test-harness';
import { cancelSyncResult, createEmptySyncResult, createSyncFailureResult } from '../sync-result';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';
import type { EncryptionReset } from '../encryption/reset';
import { loadEncryptionReset, EncryptionResetRejectedError } from '../encryption/reset';
import { SECRET_KEYS } from '../../platform/secret-keys';
import { updateSyncProgress, type SyncSettings } from '../settings';

const remote = vi.hoisted(() => vi.fn<(_reset: EncryptionReset) => Promise<void>>(async () => {}));
vi.mock('../encryption/reset', async importOriginal => ({ ...await importOriginal<typeof import('../encryption/reset')>(), resetRemoteEncryption: remote }));
beforeEach(() => {
	remote.mockReset().mockResolvedValue(undefined);
	vi.spyOn(WorkerApiHttpClient.prototype, 'getServerInfo').mockResolvedValue({ service: 'crate', serverVersion: 'test', protocol: { current: 1, oldestCompatible: 1 }, capabilities: ['e2ee-reset-v1'] });
	vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
	vi.spyOn(SyncEngine.prototype, 'sync').mockResolvedValue(createEmptySyncResult());
	vi.spyOn(SyncEngine.prototype, 'forceFullSync').mockRejectedValue(new Error('Reset must never force overwrite'));
	vi.spyOn(SyncApiClient.prototype, 'putSharedSettings').mockResolvedValue({ success: true, settingsVersion: 'new' });
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
	const harness = createRuntimeHarness({ lastSeq: 500, lastSync: '2026-01-01' });
	const bundle = await createVaultKeyBundle();
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
	// Turning encryption off starts from a connected, unlocked device, which syncs first.
	await harness.runtime.initialize({ skipStartupSync: true });
	// That start records the encrypted vault; tests check only the reset's own saves.
	harness.persistSettings.mockClear();
	const run = () => harness.runtime.turnOffEncryption(state, () => {}, { workerUrl: harness.settings.workerUrl, authToken: values.get(SECRET_KEYS.AUTH_TOKEN)! });
	return { ...harness, values, state, local, run };
}

it.each(['before dispatch', 'behind another operation'] as const)('cancels an encryption reset stopped %s', async boundary => {
	const h = await setup();
	const blocked = createDeferred<void>();
	const operations: Promise<void>[] = [];
	if (boundary === 'behind another operation') {
		const started = vi.fn(() => blocked.promise);
		operations.push(h.runtime.runEncryptionSetup(started));
		await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
	}
	operations.push(h.run());
	const settled = Promise.allSettled(operations);
	h.runtime.destroy();
	blocked.resolve();
	for (const result of await settled) {
		expect(result.status).toBe('rejected');
		if (result.status === 'rejected') expect(result.reason).toMatchObject({ name: 'AbortError' });
	}
	expect(WorkerApiHttpClient.prototype.getServerInfo).not.toHaveBeenCalled();
	expect(remote).not.toHaveBeenCalled();
	expect(h.persistSettings).not.toHaveBeenCalled();
	expect(h.plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
	expect(h.secretStorage.set).not.toHaveBeenCalled();
	expect(h.secretStorage.delete).not.toHaveBeenCalled();
	expect(h.settings.lastSeq).toBe(500);
	expect(h.runtime.isInitialized()).toBe(false);
});

it('keeps local notes, replaces credentials and sync state, then uploads without encryption', async () => {
	const h = await setup();
	try {
		// An unlocked start records the encrypted vault so a later downgrade needs confirmation.
		expect(h.settings.encryptedVaultId).toBe((JSON.parse(h.values.get(SECRET_KEYS.ENCRYPTION_KEYS)!) as { vaultId: string }).vaultId);
		await h.run();
		expect(h.settings.encryptedVaultId).toBeNull();
		expect(h.local.get('local-note.md')).toBe('keep this note');
		expect(h.local.has(h.plugin.manifest.dir + '/file-manifest.json')).toBe(false);
		expect(h.values.get(SECRET_KEYS.AUTH_TOKEN)).toMatch(/^[a-f0-9]{64}$/);
		for (const key of [SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY, SECRET_KEYS.ENCRYPTION_RESET]) expect(h.values.has(key)).toBe(false);
		expect(h.settings.lastSeq).toBe(0);
		expect(h.settings.automaticSync).toBe(true);
		// The pre-sync, then the reset upload.
		expect(SyncEngine.prototype.sync).toHaveBeenCalledTimes(2);
		expect(SyncEngine.prototype.forceFullSync).not.toHaveBeenCalled();
	} finally { h.runtime.destroy(); }
});

it('keeps the sync progress of the reset upload in the saved settings', async () => {
	const h = await setup();
	vi.mocked(SyncEngine.prototype.sync).mockResolvedValueOnce(createEmptySyncResult()).mockImplementationOnce(async function (this: SyncEngine) {
		// The engine publishes progress into the settings object it was given.
		updateSyncProgress((this as unknown as { settings: SyncSettings }).settings, { lastSeq: 42, lastSync: '2026-02-02' });
		return createEmptySyncResult();
	});
	try {
		await h.run();
		expect(h.settings.lastSeq).toBe(42);
		expect(h.settings.lastSync).toBe('2026-02-02');
		expect(h.persistSettings).toHaveBeenLastCalledWith({ automaticSync: true });
	} finally { h.runtime.destroy(); }
});

it('blocks startup and ordinary sync after failure, and resumes only the unfinished upload', async () => {
	const h = await setup();
	vi.mocked(SyncEngine.prototype.sync).mockResolvedValueOnce(createEmptySyncResult()).mockResolvedValueOnce(createSyncFailureResult('Disconnected'));
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

it('retains the reset checkpoint when reconciliation returns cancellation', async () => {
	const h = await setup();
	vi.mocked(SyncEngine.prototype.sync).mockResolvedValueOnce(createEmptySyncResult()).mockResolvedValueOnce(cancelSyncResult(createEmptySyncResult()));
	await expect(h.run()).rejects.toMatchObject({ name: 'AbortError' });
	expect(loadEncryptionReset(h.secretStorage as never)?.phase).toBe('upload');
	expect(h.settings.automaticSync).toBe(false);
	expect(SyncApiClient.prototype.putSharedSettings).not.toHaveBeenCalled();
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
	// The first initialization connected this device in setup.
	await vi.waitFor(() => expect(SyncEngine.prototype.initialize).toHaveBeenCalledTimes(2));
	h.runtime.destroy();
	initialized.resolve();
	await expect(running).rejects.toMatchObject({ name: 'AbortError' });
	// Only the pre-sync ran.
	expect(SyncEngine.prototype.sync).toHaveBeenCalledOnce();
	expect(loadEncryptionReset(h.secretStorage as never)?.phase).toBe('upload');
	expect(h.settings.automaticSync).toBe(false);
	expect(h.runtime.getApiClient()).toBeNull();
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
		// One pre-sync, then the upload and its retry.
		expect(SyncEngine.prototype.sync).toHaveBeenCalledTimes(3);
		expect(SyncEngine.prototype.forceFullSync).not.toHaveBeenCalled();
	} finally { h.runtime.destroy(); }
});

/* eslint-enable @typescript-eslint/unbound-method -- End of prototype-spy tests. */

it('refuses plaintext after keys are gone from a vault that last synced encrypted', async () => {
	const refuse = vi.spyOn(WorkerApiHttpClient.prototype, 'refusePlaintext');
	const h = createRuntimeHarness({ encryptedVaultId: 'previous-vault' });
	h.secretStorage.get.mockImplementation(key => key === SECRET_KEYS.AUTH_TOKEN ? 'auth-token' : null);
	try {
		await h.runtime.initialize({ skipStartupSync: true });
		expect(refuse).toHaveBeenLastCalledWith(true);
	} finally { h.runtime.destroy(); }
});
