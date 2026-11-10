import type { PathTags } from './path-tags';

/** The plaintext path of an encrypted file stored at `wire`, taken from its
 * authenticated metadata: the file must be stored at its own name's tag. */
export async function resolveEncryptedPath(tags: PathTags, wire: string, metadataPath: string): Promise<string> {
	if (await tags.wire(metadataPath).catch(() => null) === wire) return metadataPath;
	throw new Error('Encrypted file metadata does not match the requested file');
}
