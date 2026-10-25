import { getPortablePathIssue, getSyncPathIssue } from '../protocol/portable-path';
import { isWireSegment } from '../protocol/encrypted-path';
import type { PathTags } from './path-tags';

/** The Reading folder in both forms: notes the server seals name only its server form. */
export interface ReadingFolderForms { plain: string; wire: string }

function isNoteName(name: string): boolean {
	return name.toLowerCase().endsWith('.md') && !name.includes('/') && !getSyncPathIssue(name) && !getPortablePathIssue(name)
		&& new TextEncoder().encode(name).length <= 255;
}

const wireOf = (tags: PathTags, path: string) => tags.wire(path).catch(() => null);

/** The plaintext path of an encrypted file stored at `wire`, taken from its
 * authenticated metadata and checked against the server path. Notes created
 * without the path key keep their random server name: sealed notes in the Reading
 * folder name only its server form, and edits keep the note where it is. */
export async function resolveEncryptedPath(tags: PathTags, wire: string, metadataPath: string, sealed: boolean, reading: ReadingFolderForms | null): Promise<string> {
	const slash = wire.lastIndexOf('/'), split = metadataPath.lastIndexOf('/');
	const parentWire = wire.slice(0, slash), parent = metadataPath.slice(0, split), name = metadataPath.slice(split + 1);
	const note = slash > 0 && split > 0 && wire.endsWith('.md') && isWireSegment(wire.slice(slash + 1)) && isNoteName(name);
	// The server may plant new notes only in the Reading folder, as it always could.
	if (sealed) {
		if (note && reading && parentWire === reading.wire && parent === reading.wire) return `${reading.plain}/${name}`;
	} else if (await wireOf(tags, metadataPath) === wire || (note && await wireOf(tags, parent) === parentWire)) return metadataPath;
	throw new Error('Encrypted file metadata does not match the requested file');
}
