import { openRecoveryBundle, validateVaultKeyBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { assertEncryptionKeys, type EncryptionServerState } from '../../encryption/server-state';
import { rememberVaultKeys } from './encryption-keys';
import { loadStoredConfig } from '../config';
import { READING_SESSION_KEY } from '../reading/session/session';
import { capturePwaSession } from '../connection/session-generation';

const WRONG_RECOVERY_KEY = 'This recovery key doesn’t unlock this vault. In Obsidian, copy the Recovery key again from Crate settings → Sync → Manage encryption.';

function connectionGuard(sessionCurrent: () => boolean) {
	const remindersCurrent = capturePwaSession();
	const readingIdentity = localStorage.getItem(READING_SESSION_KEY);
	const remindersFolder = loadStoredConfig().folderPath;
	return () => sessionCurrent() && remindersCurrent()
		&& localStorage.getItem(READING_SESSION_KEY) === readingIdentity && loadStoredConfig().folderPath === remindersFolder;
}

async function storeBundle(bundle: VaultKeyBundle, expected: EncryptionServerState, current: () => boolean, mismatch: string): Promise<void> {
	if (expected.mode !== 'active') throw new Error('Finish encryption setup in Obsidian before unlocking.');
	if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
	try { assertEncryptionKeys(expected, bundle); } catch { throw new Error(mismatch); }
	await rememberVaultKeys(bundle, current);
	if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
}

/** Open the recovery bundle locally and keep its keys as non-extractable CryptoKeys.
 * The recovery code itself is never persisted in the PWA. */
export async function rememberRecoveryKey(code: string, expected: EncryptionServerState, sessionCurrent: () => boolean): Promise<void> {
	const current = connectionGuard(sessionCurrent);
	if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
	// A mistyped, outdated or other vault's key fails here with a format or cryptography message.
	const bundle = await openRecoveryBundle(expected.recovery, code).catch(() => { throw new Error(WRONG_RECOVERY_KEY); });
	await storeBundle(bundle, expected, current, WRONG_RECOVERY_KEY);
}

/** Accept the vault keys from an approved encrypted transfer. */
export async function rememberPairedBundle(payload: unknown, expected: EncryptionServerState, sessionCurrent: () => boolean): Promise<void> {
	const current = connectionGuard(sessionCurrent);
	const packet = payload as { bundle?: unknown } | null;
	if (!packet || typeof packet !== 'object' || Object.keys(packet).join() !== 'bundle') throw new Error('Invalid app key transfer.');
	try { validateVaultKeyBundle(packet.bundle); } catch { throw new Error('Invalid app key transfer.'); }
	await storeBundle(packet.bundle, expected, current, 'These keys are for a different encryption setup. Request keys again from an unlocked Obsidian device.');
}
