import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../../encryption/key-bundle';
import { createEncryptionState, type EncryptionServerState } from '../../../encryption/server-state';
import { FileKeyAuthority } from '../../../encryption/file-authority';
import { PathTags } from '../../../encryption/path-tags';
import { importNotificationKeys } from '../../../encryption/reminder-projection';
import { saveEncryptionState } from '../encryption/state';

/** A fresh vault key bundle, its recovery code and public server state in `mode`,
 * plus the file, notification and path keys a client derives from the bundle.
 * `paths.wire(path)` is where the server stores `path`. */
export async function createEncryptionFixture(mode: EncryptionServerState['mode']) {
	const bundle = await createVaultKeyBundle();
	const recovery = await generateRecoveryCode();
	const state: EncryptionServerState = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, recovery)), mode };
	return { bundle, recovery, state, keys: await FileKeyAuthority.fromBundle(bundle),
		notifications: await importNotificationKeys(bundle.vaultId, bundle.notifications),
		paths: await PathTags.fromSecret(bundle.vaultId, bundle.vault) };
}

/** Publish the vault's encryption state, as a finished encryption setup would. */
export async function storeEncryptionState(db: D1Database, state: EncryptionServerState): Promise<void> {
	await saveEncryptionState(db, state).run();
}
