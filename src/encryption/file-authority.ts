import { importEncryptionSecret, type EncryptionKey } from './envelope';
import type { FileEncryptionAuthority } from './file-codec';
import { validateVaultKeyBundle, type VaultKeyBundle } from './key-bundle';

/** Every encrypted file uses the vault key; paths are still validated locally. */
export class FileKeyAuthority {
	private constructor(readonly vaultId: string, private readonly vault: FileEncryptionAuthority) {}

	static async fromBundle(bundle: VaultKeyBundle): Promise<FileKeyAuthority> {
		validateVaultKeyBundle(bundle);
		return FileKeyAuthority.fromKey(bundle.vaultId, await importEncryptionSecret(bundle.vault));
	}

	/** For clients that keep the imported vault key instead of the bundle. */
	static fromKey(vaultId: string, key: EncryptionKey): FileKeyAuthority {
		return new FileKeyAuthority(vaultId, { vaultId, scopeId: 'vault', key });
	}

	forPath(path: string): FileEncryptionAuthority {
		if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
			throw new Error('Invalid encrypted file path');
		}
		return this.vault;
	}

	forVaultMetadata(): FileEncryptionAuthority {
		return this.vault;
	}
}
