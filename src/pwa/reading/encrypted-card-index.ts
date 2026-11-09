import { openReadingIndexShard, readingIndexContentHashes, type ReadingIndexCard, type ReadingIndexKeys } from '@/reading/core/card-index';
import { isReadingIndexHash, MAX_READING_INDEX_TAIL_PATHS, parseReadingIndexManifest, READING_INDEX_EMPTY_SHARD, type ReadingIndexManifest } from '@/protocol/reading-index';
import { parseEncryptedInventoryPage, type EncryptedInventoryFile as WireFile } from '@/encryption/file-inventory';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { isRecord } from '@/platform/validation';

/** The card index as the encrypted web app last read it. `overlay` holds the notes changed
 * after the manifest's basis, by server path; a removed note maps to null. */
export interface CardIndexState {
	etag: string; httpEtag: string; manifest: ReadingIndexManifest; lastSeq: number;
	shards: Map<string, ReadingIndexCard[]>;
	overlay: Map<string, WireFile | null>;
	/** The tail could not be replayed: the plugin has not published for too long. */
	outdated: boolean;
}
interface CardIndexDeps {
	request(path: string, headers?: Record<string, string>): Promise<Response>;
	keys: ReadingIndexKeys; wireFolder: string; generation: number;
	/** Validates a card's item fields. */
	isCard(value: unknown): value is ReadingIndexCard;
	error(message: string, status: number, code?: string): Error;
}
// Shards download a few at a time.
const SHARD_CONCURRENCY = 6;

async function json(deps: CardIndexDeps, response: Response): Promise<Record<string, unknown>> {
	const value = await response.json().catch(() => null) as unknown;
	if (!response.ok || !isRecord(value)) {
		const message = isRecord(value) && typeof value.error === 'string' ? value.error : 'Reading request failed.';
		throw deps.error(message, response.status, isRecord(value) && typeof value.code === 'string' ? value.code : undefined);
	}
	return value;
}

/**
 * Reads the card index: the manifest (one conditional request), only the shards this
 * device does not have, and the tail of changed files after the last position read.
 * Null when the server has no index for this folder and key, so the caller lists files.
 * Changed files come back as server files; the caller downloads and opens them.
 */
export async function refreshCardIndex(deps: CardIndexDeps, previous: CardIndexState | undefined): Promise<{ state: CardIndexState; added: Set<string> } | null> {
	const response = await deps.request('/reading/index', previous ? { 'If-None-Match': previous.httpEtag } : {});
	if (response.status === 404) return null;
	let state: CardIndexState, added = new Set<string>(), after: number;
	if (response.status === 304 && previous) {
		state = { ...previous, overlay: new Map(previous.overlay) };
		after = previous.lastSeq;
	} else {
		const answer = await json(deps, response);
		const manifest = parseReadingIndexManifest(answer.manifest);
		if (!manifest || typeof answer.etag !== 'string' || manifest.keyGeneration !== deps.generation) throw new Error('Reading index is unreadable.');
		// Verifies the sealed fields: the server cannot name other shards or another basis.
		await readingIndexContentHashes(manifest, deps.keys);
		const shards = new Map<string, ReadingIndexCard[]>();
		const missing = manifest.shards.flatMap((hash, shard) => hash === READING_INDEX_EMPTY_SHARD || shards.has(hash) ? []
			: previous?.shards.has(hash) ? (shards.set(hash, previous.shards.get(hash)!), []) : [{ hash, shard }]);
		await mapBounded(missing, SHARD_CONCURRENCY, async ({ hash, shard }) => {
			if (!isReadingIndexHash(hash)) throw new Error('Reading index is unreadable.');
			const download = await deps.request(`/reading/index/shard?hash=${hash}`);
			if (!download.ok) throw deps.error('Reading index shard is unavailable. Refresh to retry.', download.status, 'reading_unavailable');
			const bytes = new Uint8Array(await download.arrayBuffer());
			if (await sha256Hex(bytes) !== hash) throw new Error('Reading index shard failed verification.');
			const cards = await openReadingIndexShard(bytes, shard, manifest.generation, deps.keys);
			if (!cards.every(card => deps.isCard(card) && typeof card.wire === 'string' && card.wire.startsWith(`${deps.wireFolder}/`))) throw new Error('Reading index shard is unreadable.');
			shards.set(hash, cards as ReadingIndexCard[]);
		});
		added = new Set(missing.map(entry => entry.hash));
		state = { etag: answer.etag, httpEtag: response.headers.get('ETag') ?? `"${answer.etag}"`, manifest, lastSeq: manifest.basis, shards, overlay: new Map(), outdated: false };
		after = manifest.basis;
	}
	const tail = await json(deps, await deps.request(`/reading/index/changes?after=${after}`));
	if (tail.expired === true || tail.tooMany === true) return { state: { ...state, outdated: true }, added };
	const notes = Array.isArray(tail.notes) ? tail.notes : null, removed = Array.isArray(tail.removed) ? tail.removed : null;
	if (!notes || !removed || typeof tail.lastSeq !== 'number' || notes.length + removed.length > MAX_READING_INDEX_TAIL_PATHS
		|| !removed.every(path => typeof path === 'string' && path.startsWith(`${deps.wireFolder}/`))) throw new Error('Reading index changes are unreadable.');
	// The inventory parser validates each changed file as it validates a listing page.
	const files = parseEncryptedInventoryPage({ files: notes, nextCursor: null, sequence: tail.lastSeq, generation: deps.generation }, deps.wireFolder, deps.generation).files;
	for (const file of files) state.overlay.set(file.path, file);
	for (const path of removed as string[]) state.overlay.set(path, null);
	return { state: { ...state, lastSeq: tail.lastSeq, outdated: false }, added };
}

/** Every listed card by server path, before the overlay of later changes. */
export function indexedCards(state: CardIndexState): Map<string, ReadingIndexCard> {
	const cards = new Map<string, ReadingIndexCard>();
	for (const hash of state.manifest.shards) for (const card of state.shards.get(hash) ?? []) cards.set(card.wire!, card);
	return cards;
}
