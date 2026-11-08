import { expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { encryptionModalState, syncWithoutEncryption } from './encryption-setup';
import { SECRET_KEYS } from '../platform/secret-keys';

async function encrypted(mode: 'active' | 'resetting' = 'active') {
	const keys = await createVaultKeyBundle();
	return { keys, state: { ...createEncryptionState(keys, await sealRecoveryBundle(keys, await generateRecoveryCode())), mode } };
}

it('offers the encryption dialog view that matches the server and this device', async () => {
	const { keys, state } = await encrypted();
	const reset = await encrypted('resetting');
	const previouslyEncrypted = { encryptedVaultId: keys.vaultId }, plaintext = { encryptedVaultId: null };
	expect(encryptionModalState(reset.state, reset.keys, previouslyEncrypted)).toEqual({ kind: 'resetting' });
	expect(encryptionModalState(reset.state, null, plaintext)).toEqual({ kind: 'resetting' });
	expect(encryptionModalState(state, null, previouslyEncrypted)).toEqual({ kind: 'locked', state });
	expect(encryptionModalState(state, keys, plaintext)).toEqual({ kind: 'ready', state, keys });
	expect(encryptionModalState(null, null, previouslyEncrypted)).toEqual({ kind: 'downgraded' });
	expect(encryptionModalState(null, null, plaintext)).toEqual({ kind: 'setup' });
	// The server refuses keys this device kept after encryption was turned off, so the person chooses first.
	expect(encryptionModalState(null, keys, previouslyEncrypted)).toEqual({ kind: 'downgraded' });
	expect(encryptionModalState(null, keys, plaintext)).toEqual({ kind: 'downgraded' });
});

function downgradedPlugin(secrets = new Map<string, string>()) {
	const refusePlaintext = vi.fn();
	const writeSettings = vi.fn(async (_update: object, assertCurrent?: () => void) => { assertCurrent?.(); });
	const runEncryptionSetup = vi.fn(async (operation: () => Promise<void>) => { await operation(); });
	const secretStorage = { get: (key: string) => secrets.get(key), delete: (key: string) => { secrets.delete(key); } };
	const plugin = { writeSettings, secretStorage, syncRuntime: { getApiClient: () => ({ refusePlaintext }), runEncryptionSetup } } as unknown as CratePlugin;
	return { plugin, writeSettings, refusePlaintext, runEncryptionSetup };
}

it('removes keys kept after encryption was turned off before syncing as readable text', async () => {
	const secrets = new Map([[SECRET_KEYS.ENCRYPTION_KEYS, '{}'], [SECRET_KEYS.ENCRYPTION_RECOVERY, 'recovery'], [SECRET_KEYS.AUTH_TOKEN, 'token']]);
	const { plugin, writeSettings, runEncryptionSetup } = downgradedPlugin(secrets);
	await syncWithoutEncryption(plugin, () => {});
	expect(runEncryptionSetup).toHaveBeenCalledOnce();
	expect([...secrets.keys()]).toEqual([SECRET_KEYS.AUTH_TOKEN]);
	expect(writeSettings).toHaveBeenCalledExactlyOnceWith({ encryptedVaultId: null }, expect.any(Function));
});

it('forgets the encrypted vault and lets the current client send plaintext', async () => {
	const { plugin, writeSettings, refusePlaintext } = downgradedPlugin();
	const assertCurrent = vi.fn();
	await syncWithoutEncryption(plugin, assertCurrent);
	expect(writeSettings).toHaveBeenCalledExactlyOnceWith({ encryptedVaultId: null }, assertCurrent);
	expect(refusePlaintext).toHaveBeenCalledExactlyOnceWith(false);
	expect(assertCurrent).toHaveBeenCalledTimes(2);
});

it('keeps refusing plaintext when the connection changed', async () => {
	const { plugin, writeSettings, refusePlaintext } = downgradedPlugin();
	await expect(syncWithoutEncryption(plugin, () => { throw new Error('The server connection changed.'); })).rejects.toThrow('connection changed');
	expect(writeSettings).not.toHaveBeenCalled();
	expect(refusePlaintext).not.toHaveBeenCalled();
});
