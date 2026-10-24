import type CratePlugin from './CratePlugin';
import { loadEncryptionKeys, saveEncryptionKeys } from '../sync/encryption/key-storage';
import { createVaultKeyBundle, generateRecoveryCode, openRecoveryBundle, sealRecoveryBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import type { EncryptionServerState } from '../encryption/server-state';
import { verifyRecoveryCode } from '../encryption/recovery-verification';
import type { WorkerApiHttpClient } from '../sync/worker-api/http';
import { assertEncryptionKeys, convertEncryptedVault } from '../sync/encryption/conversion';
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

/** Save the keys and convert the server while the sync engine is frozen. Local changes
 * and durable upload receipts reconcile through encrypted sync afterward. */
export async function encryptVault(plugin: CratePlugin, http: WorkerApiHttpClient, bundle: VaultKeyBundle, recovery: string, progress: (message: string) => void, assertCurrent: () => void): Promise<void> {
	await plugin.syncRuntime.runEncryptionSetup(async () => {
		assertCurrent();
		saveEncryptionKeys(plugin.secretStorage, bundle, recovery);
		await convertEncryptedVault(http, bundle, recovery, progress, [plugin.remindersSettings.remindersFolderPath]);
	});
}

export async function unlockVault(plugin: CratePlugin, state: EncryptionServerState, recoveryCode: string, assertCurrent: () => void): Promise<void> {
	const bundle = await openRecoveryBundle(state.recovery, recoveryCode);
	assertEncryptionKeys(state, bundle);
	await plugin.syncRuntime.runEncryptionSetup(async () => {
		assertCurrent();
		saveEncryptionKeys(plugin.secretStorage, bundle, recoveryCode);
	});
}
