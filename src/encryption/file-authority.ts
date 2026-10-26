import { importEncryptionSecret, type EncryptionKey } from './envelope';
import type { FileEncryptionAuthority } from './file-codec';
import { validateVaultKeyBundle, type VaultKeyBundle } from './key-bundle';
import { importSealPrivateKey } from './seal-key';
import type { SealOpenKey } from './sealed-file-key';
import { isMarkdownPath } from '../protocol/note-paths';

/** Every encrypted file uses the vault key; paths are still validated locally.
 * Markdown may also be a note the server sealed to the vault: the path binding
 * accepts those only inside the Reading folder. */
export class FileKeyAuthority {
	private constructor(readonly vaultId: string, private readonly vault: FileEncryptionAuthority, private readonly seal?: SealOpenKey) {}

	static async fromBundle(bundle: VaultKeyBundle): Promise<FileKeyAuthority> {
		validateVaultKeyBundle(bundle);
		const seal = { keyId: bundle.seal.id, publicKey: bundle.seal.publicKey, privateKey: await importSealPrivateKey(bundle.seal) };
		return FileKeyAuthority.fromKey(bundle.vaultId, await importEncryptionSecret(bundle.vault), seal);
	}

	/** For clients that keep the imported vault keys instead of the bundle. */
	static fromKey(vaultId: string, key: EncryptionKey, seal?: SealOpenKey): FileKeyAuthority {
		return new FileKeyAuthority(vaultId, { vaultId, scopeId: 'vault', key }, seal);
	}

	forPath(path: string): FileEncryptionAuthority {
		if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
			throw new Error('Invalid encrypted file path');
		}
		return this.seal && isMarkdownPath(path) ? { ...this.vault, seal: this.seal } : this.vault;
	}

	forVaultMetadata(): FileEncryptionAuthority {
		return this.vault;
	}
}
