import { portablePathKey } from './portable-path';

/**
 * The Reading card index: the plugin writes every Reading note's card into a fixed number of
 * shards, stored by the hash of their bytes, and a manifest naming the current shards. The web
 * app reads the manifest and only the shards it does not have. The server stores the shards and
 * the manifest; it never reads a card.
 */
export const READING_INDEX_FORMAT = 1;
export const READING_INDEX_SHARDS = 64;
export const READING_INDEX_CAPABILITY = 'reading-index-v1';
/** Stored bytes of one shard: plain JSON, or an encryption envelope in an encrypted vault. */
export const MAX_READING_INDEX_SHARD_BYTES = 8 * 1024 * 1024;
/** Changed notes one tail answers; more means the index is out of date. */
export const MAX_READING_INDEX_TAIL_PATHS = 1_000;
export const MAX_READING_INDEX_MANIFEST_BYTES = 64 * 1024;
/** A shard without cards stores nothing. */
export const READING_INDEX_EMPTY_SHARD = '';

/**
 * What the plugin publishes. `basis` is the vault changelog position its cards reflect;
 * later changes reach the web app through the tail. `shards` holds the SHA-256 of each
 * shard's stored bytes, or `''` for an empty shard. An encrypted vault adds the key
 * generation and `sealed`, the same fields encrypted with the vault key, so the server
 * cannot point the web app at other shards.
 */
export interface ReadingIndexManifest {
	format: typeof READING_INDEX_FORMAT;
	/** The Reading policy generation the cards were built for. */
	generation: string;
	basis: number;
	shards: string[];
	keyGeneration?: number;
	sealed?: string;
}

const HASH = /^[a-f0-9]{64}$/;
export const isReadingIndexHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

/** The shard a note's card lives in, from its portable path, so letter case cannot split a note. */
export function readingIndexShard(path: string): number {
	let hash = 0x811c9dc5;
	for (const char of portablePathKey(path)) {
		hash ^= char.codePointAt(0)!;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % READING_INDEX_SHARDS;
}

export function parseReadingIndexManifest(value: unknown): ReadingIndexManifest | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const manifest = value as Record<string, unknown>;
	if (manifest.format !== READING_INDEX_FORMAT || typeof manifest.generation !== 'string' || !manifest.generation || manifest.generation.length > 128
		|| typeof manifest.basis !== 'number' || !Number.isSafeInteger(manifest.basis) || manifest.basis < 0
		|| !Array.isArray(manifest.shards) || manifest.shards.length !== READING_INDEX_SHARDS
		|| !manifest.shards.every(hash => hash === READING_INDEX_EMPTY_SHARD || isReadingIndexHash(hash))) return null;
	const encrypted = manifest.keyGeneration !== undefined || manifest.sealed !== undefined;
	if (encrypted && (typeof manifest.keyGeneration !== 'number' || !Number.isSafeInteger(manifest.keyGeneration) || manifest.keyGeneration < 0
		|| typeof manifest.sealed !== 'string' || !manifest.sealed || manifest.sealed.length > MAX_READING_INDEX_MANIFEST_BYTES)) return null;
	return {
		format: READING_INDEX_FORMAT, generation: manifest.generation, basis: manifest.basis, shards: [...manifest.shards as string[]],
		...(encrypted ? { keyGeneration: manifest.keyGeneration as number, sealed: manifest.sealed as string } : {}),
	};
}

/** The tail after a manifest's basis: notes in the Reading folder written or deleted since. */
export interface ReadingIndexTail<Note> {
	/** The changelog position this answer reflects; the next tail starts here. */
	lastSeq: number;
	/** Current state of each changed note that exists. */
	notes: Note[];
	/** Changed paths that no longer hold a note. */
	removed: string[];
}
