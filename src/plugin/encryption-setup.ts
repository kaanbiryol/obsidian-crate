import type CratePlugin from './CratePlugin';
import { loadEncryptionKeys, saveEncryptionKeys } from '../sync/encryption/key-storage';
import { createVaultKeyBundle, generateRecoveryCode, openRecoveryBundle, sealRecoveryBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import { verifyRecoveryCode } from '../encryption/recovery-verification';
import { assertEncryptionKeys, type EncryptionServerState } from '../encryption/server-state';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { SECRET_KEYS } from '../platform/secret-keys';

/** Keys saved on this device, or null when they cannot unlock the server's encryption. */
export function loadDeviceEncryptionKeys(plugin: CratePlugin, state: EncryptionServerState | null): VaultKeyBundle | null {
	try {
		const keys = loadEncryptionKeys(plugin.secretStorage);
		if (state && keys) assertEncryptionKeys(state, keys);
		return keys;
	} catch (error) {
		if (!state) throw error;
		return null;
	}
}

/** Reuse this device's keys and recovery key, or create both. */
export async function prepareEncryptionKeys(plugin: CratePlugin, keys: VaultKeyBundle | null): Promise<{ bundle: VaultKeyBundle; recovery: string | null }> {
	if (keys) return { bundle: keys, recovery: plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) };
	return { bundle: await createVaultKeyBundle(), recovery: await generateRecoveryCode() };
}

/** Confirm the recovery key opens the server's recovery envelope, or a new one sealed for these keys. */
export async function verifySetupRecovery(state: EncryptionServerState | null, bundle: VaultKeyBundle, recovery: string): Promise<void> {
	await verifyRecoveryCode(state?.recovery ?? await sealRecoveryBundle(bundle, recovery), recovery, bundle);
}

/** Replace the server copy, history and checkpoints with this device's vault, encrypted.
 * A saved checkpoint resumes the same setup after an interruption. */
export async function encryptVault(plugin: CratePlugin, bundle: VaultKeyBundle, recovery: string, progress: (message: string) => void, assertCurrent: () => void): Promise<void> {
	assertCurrent();
	await plugin.syncRuntime.turnOnEncryption(bundle, recovery, progress,
		{ workerUrl: plugin.settings.workerUrl, authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '' }, getPluginLifecycleSignal(plugin));
}

export async function unlockVault(plugin: CratePlugin, state: EncryptionServerState, recoveryCode: string, assertCurrent: () => void): Promise<void> {
	const bundle = await openRecoveryBundle(state.recovery, recoveryCode);
	assertEncryptionKeys(state, bundle);
	await plugin.syncRuntime.runEncryptionSetup(async () => {
		assertCurrent();
		saveEncryptionKeys(plugin.secretStorage, bundle, recoveryCode);
	});
}
