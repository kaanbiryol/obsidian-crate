import { importEncryptionSecret, type EncryptionKey } from './envelope';
import type { FileEncryptionAuthority } from './file-codec';
import { validateVaultKeyBundle, type VaultKeyBundle } from './key-bundle';
import { importSealPrivateKey } from './seal-key';
import type { SealOpenKey } from './sealed-file-key';

/** Every encrypted file uses the vault key; paths are still validated locally.
 * Files the server sealed to the vault open only as Markdown inside the Reading folder. */
export class FileKeyAuthority {
	private constructor(readonly vaultId: string, private readonly vault: FileEncryptionAuthority,
		private readonly seal?: SealOpenKey, private readonly readingFolder: () => string | null = () => null) {}

	static async fromBundle(bundle: VaultKeyBundle, readingFolder?: () => string | null): Promise<FileKeyAuthority> {
		validateVaultKeyBundle(bundle);
		const seal = { keyId: bundle.seal.id, publicKey: bundle.seal.publicKey, privateKey: await importSealPrivateKey(bundle.seal) };
		return FileKeyAuthority.fromKey(bundle.vaultId, await importEncryptionSecret(bundle.vault), seal, readingFolder);
	}

	/** For clients that keep the imported vault keys instead of the bundle. */
	static fromKey(vaultId: string, key: EncryptionKey, seal?: SealOpenKey, readingFolder?: () => string | null): FileKeyAuthority {
		return new FileKeyAuthority(vaultId, { vaultId, scopeId: 'vault', key }, seal, readingFolder);
	}

	forPath(path: string): FileEncryptionAuthority {
		if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
			throw new Error('Invalid encrypted file path');
		}
		const folder = this.seal && this.readingFolder();
		return folder && path.startsWith(`${folder}/`) && path.toLowerCase().endsWith('.md') ? { ...this.vault, seal: this.seal } : this.vault;
	}

	forVaultMetadata(): FileEncryptionAuthority {
		return this.vault;
	}
}
