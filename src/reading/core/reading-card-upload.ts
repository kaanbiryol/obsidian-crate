import { isMarkdownNoteInFolder } from '@/protocol/note-paths';
import { sha256Hex } from '@/platform/sha256';
import { MAX_READING_BYTES } from './model';
import { parseReadingNote } from './notes';
import { readingCardData, type ReadingCardData, type ReadingCardKeys } from './reading-card';

/** The card a device attaches when it encrypts `path` for upload to `wire`, or null when the
 * file is not a readable Reading note in `folder`. A note without a card still uploads; it is
 * listed again once a device saves it as a valid note. */
export async function readingUploadCard(folder: string | null | undefined, path: string, wire: string, bytes: ArrayBuffer | Uint8Array,
	keys: ReadingCardKeys & { searchKey: CryptoKey }): Promise<ReadingCardData | null> {
	if (!folder || !isMarkdownNoteInFolder(path, folder) || bytes.byteLength > MAX_READING_BYTES) return null;
	const content = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let metadata: ReturnType<typeof parseReadingNote>;
	try { metadata = parseReadingNote(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)); } catch { return null; }
	if (!metadata) return null;
	// A card that cannot be built never blocks the note's upload.
	try { return await readingCardData({ ...metadata, path }, wire, await sha256Hex(content), keys); } catch { return null; }
}
