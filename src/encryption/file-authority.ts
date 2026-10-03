import { importEncryptionSecret } from './envelope';
import type { FileEncryptionAuthority } from './file-codec';
import { validateReminderKeyGrant, validateVaultKeyBundle, type ReminderKeyGrant, type VaultKeyBundle } from './key-bundle';

function within(path: string, folder: string): boolean {
	return path.startsWith(`${folder}/`);
}

/** Keys are selected locally. A server-supplied scope can never broaden a grant. */
export class FileKeyAuthority {
	private constructor(
		readonly vaultId: string,
		private readonly vault: FileEncryptionAuthority | undefined,
		private readonly scopes: ReadonlyArray<{ folderPath: string; authority: FileEncryptionAuthority }>,
	) {}

	static async fromVault(bundle: VaultKeyBundle): Promise<FileKeyAuthority> {
		validateVaultKeyBundle(bundle);
		return new FileKeyAuthority(bundle.vaultId,
			{ vaultId: bundle.vaultId, scopeId: 'vault', key: await importEncryptionSecret(bundle.vault) },
			await Promise.all(bundle.scopes.map(async scope => ({ folderPath: scope.folderPath,
				authority: { vaultId: bundle.vaultId, scopeId: scope.id, key: await importEncryptionSecret(scope.data) } }))));
	}

	static async fromReminderGrant(grant: ReminderKeyGrant): Promise<FileKeyAuthority> {
		validateReminderKeyGrant(grant);
		return new FileKeyAuthority(grant.vaultId, undefined, [{ folderPath: grant.scope.folderPath,
			authority: { vaultId: grant.vaultId, scopeId: grant.scope.id, key: await importEncryptionSecret(grant.scope.data) } }]);
	}

	forPath(path: string): FileEncryptionAuthority {
		if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
			throw new Error('Invalid encrypted file path');
		}
		const scope = this.scopes.filter(item => within(path, item.folderPath))
			.sort((left, right) => right.folderPath.length - left.folderPath.length)[0];
		const authority = scope?.authority ?? this.vault;
		if (!authority) throw new Error('This device does not have encryption keys for that folder');
		return authority;
	}

	forVaultMetadata(): FileEncryptionAuthority {
		if (!this.vault) throw new Error('This device does not have the vault metadata key');
		return this.vault;
	}

	/** Only a full-vault client can recover a prior scope during conversion.
	 * Folder grants must continue to select authority from their enrolled path. */
	forPriorScope(scopeId: string, keyId: string): FileEncryptionAuthority {
		if (!this.vault) throw new Error('The vault key is required to convert an encrypted folder');
		const authority = scopeId === 'vault' ? this.vault : this.scopes.find(scope => scope.authority.scopeId === scopeId)?.authority;
		if (!authority || authority.key.id !== keyId) throw new Error('The original folder key is unavailable');
		return authority;
	}
}
