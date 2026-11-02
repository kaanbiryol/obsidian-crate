import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';
import type { SecretStorageService } from '../../plugin/secret-storage';
import { loadEncryptionKeys } from '../encryption/key-storage';
import type { SyncApiClient } from '../worker-api/client';
import type { SyncSettings } from '../settings';

const logger = createLogger('SyncRuntime');

export interface ApiClientEncryptionSetup {
	settings: SyncSettings;
	secretStorage: SecretStorageService;
	persistSettings: (update?: Partial<SyncSettings>) => Promise<void>;
	/** Notes inside these folders carry encrypted notification schedules. */
	reminderFolders: () => readonly string[];
	readingFolder: () => string | null;
	/** Whether `client` is still the runtime's connection. */
	isCurrent: (client: SyncApiClient) => boolean;
}

/** Decides a new client's encryption state: it uses this device's keys, or, without
 * keys, refuses plaintext for a vault that last synced encrypted. */
export async function configureClientEncryption(client: SyncApiClient, setup: ApiClientEncryptionSetup): Promise<void> {
	const { settings, secretStorage } = setup;
	const keys = loadEncryptionKeys(secretStorage);
	if (keys) {
		await client.configureEncryption(keys, setup.reminderFolders, setup.readingFolder);
		if (settings.encryptedVaultId !== keys.vaultId) await setup.persistSettings({ encryptedVaultId: keys.vaultId });
		return;
	}
	client.refusePlaintext(Boolean(settings.encryptedVaultId));
	if (!settings.encryptedVaultId) rememberEncryptedVault(client, setup);
}

/** Record the vault the first time its server reports encryption to this keyless device,
 * so a later report that encryption is off cannot receive plaintext unprompted. */
function rememberEncryptedVault(client: SyncApiClient, setup: ApiClientEncryptionSetup): void {
	let reading: Promise<void> | null = null;
	client.observeEncryption(() => {
		reading ??= (async () => {
			const state = await client.getEncryptionState();
			if (!setup.isCurrent(client) || setup.settings.encryptedVaultId || loadEncryptionKeys(setup.secretStorage)) {
				client.observeEncryption(undefined);
				return;
			}
			if (!state) return;
			client.refusePlaintext(true);
			await setup.persistSettings({ encryptedVaultId: state.vaultId });
			client.observeEncryption(undefined);
		})().catch(error => { logger.warn('Could not record that this vault is encrypted:', errorMessage(error)); })
			.finally(() => { reading = null; });
	});
}
