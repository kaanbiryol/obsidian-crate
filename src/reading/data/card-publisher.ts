import { parseReadingNote } from '../core/notes';
import { readingCardFields, sealReadingCard, type ReadingCardKeys } from '../core/reading-card';
import { hashedReadingTerms } from '@/encryption/reading-search';
import { sha256Hex } from '@/platform/sha256';
import type { ReadingFile, ReadingVault } from './library';

/** The server side of posting cards; `SyncApiClient` implements it. */
export interface ReadingCardServer {
	readingCardKeys(): (ReadingCardKeys & { searchKey: CryptoKey }) | null;
	encryptedServerPath(path: string): Promise<string | undefined>;
	staleReadingCards(after: string): Promise<{ files: Array<{ path: string; revision: string }>; cursor: string | null }>;
	postReadingCards(cards: unknown[]): Promise<void>;
}
type PublisherVault = Pick<ReadingVault, 'files' | 'read'>;
// One post stays under the Worker's body limit.
const MAX_POST_CARDS = 50, MAX_POST_BYTES = 200 * 1024;

/**
 * In an encrypted vault the server cannot read notes, so after a sync Obsidian posts the card
 * of each Reading note the server lists without one. It uses only notes whose local copy is
 * the synced one (`synced`), and reads each note it posts. A note the server sealed, such as a
 * Shortcut save, is here only after sync accepted it, so its card is posted too.
 */
export class ReadingCardPublisher {
	constructor(private vault: PublisherVault, readonly folder: string) {}

	private isNotePath(path: string): boolean { return path.startsWith(`${this.folder}/`) && /\.md$/i.test(path); }

	/** Posts cards for every stale note this device holds, and returns how many it posted. */
	async publish(server: ReadingCardServer, synced: (path: string) => boolean, signal?: AbortSignal): Promise<number> {
		const keys = server.readingCardKeys();
		if (!keys) return 0;
		// Most syncs leave nothing stale, so the notes are mapped to server paths only when needed.
		let local: Map<string, ReadingFile> | undefined;
		let after: string | null = '', posted = 0;
		while (after !== null) {
			signal?.throwIfAborted();
			const page: Awaited<ReturnType<ReadingCardServer['staleReadingCards']>> = await server.staleReadingCards(after);
			after = page.cursor;
			if (!page.files.length) continue;
			if (!local) {
				local = new Map();
				for (const file of this.vault.files()) {
					if (!this.isNotePath(file.path) || !synced(file.path)) continue;
					const wire = await server.encryptedServerPath(file.path);
					if (!wire) return 0;
					local.set(wire, file);
				}
			}
			const cards: unknown[] = [];
			for (const stale of page.files) {
				const file = local.get(stale.path);
				if (!file) continue;
				const text = await this.vault.read(file);
				let metadata: ReturnType<typeof parseReadingNote>;
				try { metadata = parseReadingNote(text); } catch { continue; }
				if (!metadata) continue;
				const item = { ...metadata, path: file.path };
				cards.push({ path: stale.path, revision: stale.revision, card: await sealReadingCard(item, stale.path, await sha256Hex(new TextEncoder().encode(text)), keys),
					terms: await hashedReadingTerms(keys.searchKey, item), ...readingCardFields(item) });
			}
			for (let start = 0; start < cards.length;) {
				let end = start, bytes = 0;
				while (end < cards.length && end - start < MAX_POST_CARDS && (end === start || bytes + JSON.stringify(cards[end]).length < MAX_POST_BYTES)) bytes += JSON.stringify(cards[end++]).length;
				// A note that changed meanwhile is skipped by the server and posted after the next sync.
				await server.postReadingCards(cards.slice(start, end));
				posted += end - start; start = end;
			}
		}
		return posted;
	}
}
