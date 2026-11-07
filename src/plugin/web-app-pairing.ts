import type CratePlugin from './CratePlugin';
import { captureServerConnection, guardedServerClient } from './server-request';
import { loadEncryptionKeys } from '../sync/encryption/key-storage';
import { sameVaultKeyBundle, validateVaultKeyBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import { PAIRING_PATH, PairingEndedError, type PairingContext, type PairingTransport } from '../encryption/pairing/protocol';
import { requestAppPairing } from '../encryption/pairing/session';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { readServerEncryption } from '../sync/encryption/server-encryption';
import { assertEncryptionKeys, type EncryptionServerState } from '../encryption/server-state';
import { unlockVaultWithPairedKeys } from './encryption-setup';

function pairingTransport(http: WorkerApiHttpClient): PairingTransport {
	return {
		read: id => http.requestJson(`${PAIRING_PATH}${id ? `?id=${encodeURIComponent(id)}` : ''}`, undefined, 10_000),
		write: body => http.requestJson(PAIRING_PATH, { method: 'POST', body: JSON.stringify(body) }, 10_000),
	};
}

export async function openWebAppPairing(plugin: CratePlugin, signal: AbortSignal) {
	const connection = captureServerConnection(plugin);
	const keys = loadEncryptionKeys(plugin.secretStorage);
	if (!keys || !connection.origin || !connection.token) throw new Error('Unlock this Obsidian vault before connecting an app.');
	const current = () => {
		connection.assertCurrent(); signal.throwIfAborted();
		const latest = loadEncryptionKeys(plugin.secretStorage);
		if (!latest || !sameVaultKeyBundle(keys, latest)) throw new Error('The vault changed. Reopen Connect web app.');
	};
	const http = guardedServerClient(connection.origin, connection.token, current);
	http.setAbortSignal(AbortSignal.any([signal, connection.signal]));
	http.setEncryptionAuthority(keys.vaultId, keys.generation);
	const transport = pairingTransport(http);
	const validate = (context: PairingContext) => {
		current();
		if (context.origin !== new URL(connection.origin).origin || context.vaultId !== keys.vaultId || context.generation !== keys.generation) throw new Error('This app request does not match the unlocked vault.');
	};
	return { transport, current, validate, async cancel(id: string) {
		connection.assertCurrent();
		const cleanup = new WorkerApiHttpClient(connection.origin, connection.token!);
		cleanup.setAbortSignal(connection.signal);
		await cleanup.requestJson(PAIRING_PATH, { method: 'POST', body: JSON.stringify({ action: 'cancel', id }) }, 5000);
	}, async payload(context: PairingContext) {
		validate(context);
		const state = await readServerEncryption(http, 10_000);
		current();
		if (!state || state.mode !== 'active') throw new Error('Finish encryption setup before approving this app.');
		assertEncryptionKeys(state, keys);
		return { bundle: keys };
	} };
}

/** Asks a device that holds the vault keys to send them to this one. `start` opens a
 * request for the server's current encryption. Once the user confirmed that both
 * screens show the same code, `unlock` checks that the vault is unchanged and unlocks
 * this device with the received keys. */
export function openDeviceKeyRequest(plugin: CratePlugin, signal: AbortSignal) {
	const connection = captureServerConnection(plugin);
	const current = () => { signal.throwIfAborted(); connection.assertCurrent(); };
	const http = new WorkerApiHttpClient(connection.origin, connection.token ?? '');
	http.setAbortSignal(AbortSignal.any([signal, connection.signal]));
	let expected: EncryptionServerState | undefined;
	return {
		async start() {
			expected = await readServerEncryption(http) ?? undefined;
			current();
			if (expected?.mode !== 'active') throw new Error('This vault is not encrypted. Close this window and sync.');
			return requestAppPairing({ version: 1, id: crypto.randomUUID(), origin: new URL(connection.origin).origin,
				vaultId: expected.vaultId, generation: expected.generation }, pairingTransport(http), current);
		},
		async unlock(payload: unknown): Promise<void> {
			const latest = await readServerEncryption(http);
			current();
			if (!expected || !latest || latest.vaultId !== expected.vaultId || latest.generation !== expected.generation || latest.keyId !== expected.keyId) {
				throw new PairingEndedError('The vault changed. Start again.');
			}
			await unlockVaultWithPairedKeys(plugin, latest, pairedBundle(payload), current);
		},
	};
}

/** A key transfer carries exactly a valid vault key bundle. */
function pairedBundle(payload: unknown): VaultKeyBundle {
	const packet = payload as { bundle?: unknown } | null;
	if (!packet || typeof packet !== 'object' || Object.keys(packet).join() !== 'bundle') throw new Error('Invalid key transfer.');
	try { validateVaultKeyBundle(packet.bundle); } catch { throw new Error('Invalid key transfer.'); }
	return packet.bundle;
}
