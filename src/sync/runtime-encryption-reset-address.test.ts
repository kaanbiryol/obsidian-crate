import { afterEach, expect, it, vi } from 'vitest';
import { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS } from '../plugin/settings-types';
import { createEncryptionReset, loadEncryptionReset, saveEncryptionReset, type EncryptionReset } from './encryption-reset';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { WorkerApiHttpClient } from './worker-api/http';
import { createRuntimeHarness } from './runtime-test-harness';

afterEach(() => vi.restoreAllMocks());
const oldUrl = 'https://old.trycloudflare.com', newUrl = 'https://new.trycloudflare.com';
async function setup(phase: EncryptionReset['phase'] = 'upload') {
	const h = createRuntimeHarness({ workerUrl: oldUrl, automaticSync: false });
	const raw = new Map<string, string>();
	const setSecret = vi.fn((id: string, value: string) => { raw.set(id, value); });
	const storage = new SecretStorageService({ secretStorage: { getSecret: (id: string) => raw.get(id), setSecret } } as never, () => h.settings.workerUrl);
	h.secretStorage.get.mockImplementation(key => storage.get(key as never));
	h.secretStorage.set.mockImplementation((key, value) => storage.set(key as never, value));
	h.secretStorage.has.mockImplementation(key => storage.has(key as never));
	h.secretStorage.delete.mockImplementation(key => storage.delete(key as never));
	Object.assign(h.secretStorage, { forScope: (scope: string) => storage.forScope(scope) });
	const bundle = createVaultKeyBundle();
	const state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' as const };
	const reset = { ...createEncryptionReset(oldUrl, 'old-token', state, true), phase };
	saveEncryptionReset(storage, reset);
	storage.set(SECRET_KEYS.AUTH_TOKEN, phase === 'upload' ? reset.replacementToken : reset.oldToken);
	if (phase !== 'upload') {
		storage.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle));
		storage.set(SECRET_KEYS.ENCRYPTION_RECOVERY, 'saved recovery');
	}
	const requests = vi.spyOn(WorkerApiHttpClient.prototype, 'requestJson').mockResolvedValue({ ...reset, complete: phase !== 'remote' });
	const persisted: string[] = [];
	h.persistSettings.mockImplementation(async () => { persisted.push(h.settings.workerUrl); });
	return { ...h, storage, setSecret, requests, reset, persisted, bundle };
}

it.each(['remote', 'local', 'upload'] as const)('moves phase %s and its credentials to a verified address while keeping sync paused', async phase => {
	const h = await setup(phase);
	await h.runtime.updateEncryptionResetAddress(newUrl);
	expect(h.settings.workerUrl).toBe(newUrl);
	expect(h.persisted).toEqual([newUrl]);
	expect(loadEncryptionReset(h.storage)).toEqual({ ...h.reset, workerUrl: newUrl });
	expect(h.storage.get(SECRET_KEYS.AUTH_TOKEN)).toBe(phase === 'upload' ? h.reset.replacementToken : h.reset.oldToken);
	expect(h.storage.get(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(phase === 'upload' ? null : JSON.stringify(h.bundle));
	await h.runtime.initialize();
	expect(h.runtime.getApiClient()).toBeNull();
	expect(h.settings.automaticSync).toBe(false);
	h.runtime.destroy();
});

it('rejects a different reset receipt without changing either scope or disk', async () => {
	const h = await setup();
	h.requests.mockResolvedValue({ ...h.reset, id: 'different-reset', complete: true });
	await expect(h.runtime.updateEncryptionResetAddress(newUrl)).rejects.toThrow('did not confirm');
	expect(h.settings.workerUrl).toBe(oldUrl);
	expect(loadEncryptionReset(h.storage)).toEqual(h.reset);
	expect(loadEncryptionReset(h.storage.forScope(newUrl))).toBeNull();
	expect(h.plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
});

it('keeps the original scope usable if writing the destination credentials fails', async () => {
	const h = await setup();
	h.setSecret.mockImplementationOnce(() => { throw new Error('Keychain failed'); });
	await expect(h.runtime.updateEncryptionResetAddress(newUrl)).rejects.toThrow('Keychain failed');
	expect(h.settings.workerUrl).toBe(oldUrl);
	expect(loadEncryptionReset(h.storage)).toEqual(h.reset);
	expect(h.persisted).toEqual([]);
	await h.runtime.updateEncryptionResetAddress(newUrl);
	expect(loadEncryptionReset(h.storage)?.id).toBe(h.reset.id);
});

it('preserves both recovery scopes when saving the new URL fails, then retries safely', async () => {
	const h = await setup();
	h.persistSettings.mockRejectedValueOnce(new Error('Settings failed'));
	await expect(h.runtime.updateEncryptionResetAddress(newUrl)).rejects.toThrow('Settings failed');
	expect(h.settings.workerUrl).toBe(oldUrl);
	expect(loadEncryptionReset(h.storage)).toEqual(h.reset);
	expect(loadEncryptionReset(h.storage.forScope(newUrl))).toEqual({ ...h.reset, workerUrl: newUrl });
	await h.runtime.updateEncryptionResetAddress(newUrl);
	expect(h.settings.workerUrl).toBe(newUrl);
});
