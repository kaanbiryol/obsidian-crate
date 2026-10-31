import type CratePlugin from './CratePlugin';
import { loadEncryptionKeys, savePairedEncryptionKeys, saveEncryptionKeys } from '../sync/encryption/key-storage';
import { createVaultKeyBundle, generateRecoveryCode, openRecoveryBundle, sealRecoveryBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import { verifyRecoveryCode } from '../encryption/recovery-verification';
import { assertEncryptionKeys, type EncryptionServerState } from '../encryption/server-state';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { readServerEncryption } from '../sync/encryption/server-encryption';
import { SECRET_KEYS } from '../platform/secret-keys';
import { captureServerConnection } from './server-request';

/** A Worker API client for the current server connection, and a check that it is still current. */
export function openEncryptionConnection(plugin: CratePlugin): { http: WorkerApiHttpClient; assertCurrent: () => void } {
	const { signal, origin, token, assertCurrent } = captureServerConnection(plugin);
	const http = new WorkerApiHttpClient(origin, token ?? '');
	http.setAbortSignal(signal);
	return { http, assertCurrent };
}

/** The server's encryption state, rejected when the connection changed while it was read. */
export async function readEncryptionStatus(plugin: CratePlugin, timeout?: number): Promise<EncryptionServerState | null> {
	const { http, assertCurrent } = openEncryptionConnection(plugin);
	const state = await readServerEncryption(http, timeout);
	assertCurrent();
	return state;
}

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

type PreparedKeys = { bundle: VaultKeyBundle; recovery: string };

/** Keys created for setup, by server, until encryption is turned on. Reopening setup shows
 * the recovery key the user may already have saved instead of a new one. */
const preparedKeys = new WeakMap<CratePlugin, Map<string, PreparedKeys>>();

/** Reuse this device's keys and recovery key, or the ones created for this server's setup, or create both. */
export async function prepareEncryptionKeys(plugin: CratePlugin, keys: VaultKeyBundle | null): Promise<{ bundle: VaultKeyBundle; recovery: string | null }> {
	if (keys) return { bundle: keys, recovery: plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) };
	const { workerUrl } = plugin.settings;
	const byServer = preparedKeys.get(plugin) ?? new Map<string, PreparedKeys>();
	preparedKeys.set(plugin, byServer);
	let prepared = byServer.get(workerUrl);
	if (!prepared) {
		prepared = { bundle: await createVaultKeyBundle(), recovery: await generateRecoveryCode() };
		byServer.set(workerUrl, prepared);
	}
	return prepared;
}

/** Confirm the recovery key opens the server's recovery envelope, or a new one sealed for these keys. */
export async function verifySetupRecovery(state: EncryptionServerState | null, bundle: VaultKeyBundle, recovery: string): Promise<void> {
	await verifyRecoveryCode(state?.recovery ?? await sealRecoveryBundle(bundle, recovery), recovery, bundle);
}

/** Replace the server copy, history and checkpoints with this device's vault, encrypted.
 * A saved checkpoint resumes the same setup after an interruption. */
export async function encryptVault(plugin: CratePlugin, bundle: VaultKeyBundle, recovery: string, progress: (message: string) => void, assertCurrent: () => void): Promise<void> {
	assertCurrent();
	const { workerUrl } = plugin.settings;
	await plugin.syncRuntime.turnOnEncryption(bundle, recovery, progress,
		{ workerUrl, authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '' }, getPluginLifecycleSignal(plugin));
	preparedKeys.get(plugin)?.delete(workerUrl);
}

/** Unlocks with keys another device approved; the caller has already confirmed the comparison code. */
export async function unlockVaultWithPairedKeys(plugin: CratePlugin, state: EncryptionServerState, bundle: VaultKeyBundle, assertCurrent: () => void): Promise<void> {
	assertEncryptionKeys(state, bundle);
	await plugin.syncRuntime.runEncryptionSetup(async () => {
		assertCurrent();
		savePairedEncryptionKeys(plugin.secretStorage, bundle);
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
