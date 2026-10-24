import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../../encryption/key-bundle';
import { createEncryptionState, type EncryptionServerState } from '../../../encryption/server-state';
import { FileKeyAuthority } from '../../../encryption/file-authority';
import { importNotificationKeys } from '../../../encryption/reminder-projection';
import { ENCRYPTION_STATE_KEY } from '../encryption/state';

/** A fresh vault key bundle, its recovery code and public server state in `mode`,
 * plus the file and notification keys a client imports from the bundle. */
export async function createEncryptionFixture(mode: EncryptionServerState['mode']) {
	const bundle = await createVaultKeyBundle();
	const recovery = await generateRecoveryCode();
	const state: EncryptionServerState = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, recovery)), mode };
	return { bundle, recovery, state, keys: await FileKeyAuthority.fromBundle(bundle),
		notifications: await importNotificationKeys(bundle.vaultId, bundle.notifications) };
}

/** Publish the vault's encryption state, as a finished conversion step would. */
export async function storeEncryptionState(db: D1Database, state: EncryptionServerState): Promise<void> {
	await db.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
}
