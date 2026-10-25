import { decryptJson, encryptJson, type EncryptionKey } from './envelope';
import type { PathTags } from './path-tags';

const context = (vaultId: string) => ({ vaultId, scopeId: 'vault', objectId: 'folder-label', purpose: 'settings' as const });

/** The server stores feature folders by their tags; this label lets another device
 * or web app recover the plaintext name. */
export async function sealFolderLabel(path: string, tags: PathTags, key: EncryptionKey, vaultId: string): Promise<{ wire: string; label: string }> {
	const wire = await tags.wire(path);
	return { wire, label: await encryptJson({ wire, path }, key, context(vaultId)) };
}

export async function openFolderLabel(wire: string, label: string, tags: PathTags, key: EncryptionKey, vaultId: string): Promise<string> {
	const value = await decryptJson(label, key, context(vaultId)) as { wire?: unknown; path?: unknown } | null;
	if (!value || value.wire !== wire || typeof value.path !== 'string' || await tags.wire(value.path).catch(() => null) !== wire) {
		throw new Error('The encrypted folder name does not match this vault');
	}
	return value.path;
}
