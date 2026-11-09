import type { ReadingItem } from './model';
import { decryptJson, encryptJson, type EncryptionKey } from '@/encryption/envelope';
import { sha256Hex } from '@/platform/sha256';
import {
	READING_INDEX_EMPTY_SHARD, READING_INDEX_FORMAT, READING_INDEX_SHARDS, readingIndexShard, type ReadingIndexManifest,
} from '@/protocol/reading-index';

/** One note's card: the listed item, and in an encrypted vault its server path (the path's
 * tag, or the random name of a note the server sealed). */
export type ReadingIndexCard = ReadingItem & { wire?: string };
/** A shard's plaintext. Cards are sorted by path, so equal notes give equal bytes. */
interface ShardBody { format: typeof READING_INDEX_FORMAT; shard: number; cards: ReadingIndexCard[] }
/** Keys an encrypted vault seals the index with. */
export interface ReadingIndexKeys { vaultId: string; key: EncryptionKey; keyGeneration: number }
/** What a sealed manifest proves: these exact shards, their plaintext hashes and basis. */
interface SealedFields { generation: string; basis: number; shards: string[]; content: string[] }

const context = (keys: ReadingIndexKeys, objectId: string) => ({ vaultId: keys.vaultId, scopeId: 'vault', objectId, purpose: 'reading-index' as const });
// Object IDs bind each envelope to its place; the policy generation is an encryption ID.
const generationId = (generation: string) => {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(generation)) throw new Error('Reading index generation is invalid.');
	return generation;
};
const shardObject = (generation: string, keys: ReadingIndexKeys, shard: number) => `reading-index-shard-${keys.keyGeneration}-${shard}-${generationId(generation)}`;
const manifestObject = (generation: string, keys: ReadingIndexKeys) => `reading-index-manifest-${keys.keyGeneration}-${generationId(generation)}`;

/** Each shard's plaintext JSON and its SHA-256, or `''` for both when it holds no card. */
export async function buildReadingIndexShards(cards: Iterable<ReadingIndexCard>): Promise<Array<{ json: string; content: string }>> {
	const groups = Array.from({ length: READING_INDEX_SHARDS }, () => [] as ReadingIndexCard[]);
	for (const card of cards) groups[readingIndexShard(card.path)]!.push(card);
	return Promise.all(groups.map(async (group, shard) => {
		if (!group.length) return { json: '', content: READING_INDEX_EMPTY_SHARD };
		group.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		const json = JSON.stringify({ format: READING_INDEX_FORMAT, shard, cards: group } satisfies ShardBody);
		return { json, content: await sha256Hex(json) };
	}));
}

/** The bytes the server stores for a shard: its JSON, or an envelope sealed to its place. */
export async function storedReadingIndexShard(json: string, shard: number, generation: string, keys?: ReadingIndexKeys): Promise<Uint8Array<ArrayBuffer>> {
	const text = keys ? await encryptJson(JSON.parse(json) as unknown, keys.key, context(keys, shardObject(generation, keys, shard))) : json;
	return new TextEncoder().encode(text);
}

/** A shard's cards from its stored bytes, checked against the shard it was listed as. Each
 * card's fields are validated by the caller. */
export async function openReadingIndexShard(bytes: Uint8Array<ArrayBuffer>, shard: number, generation: string, keys?: ReadingIndexKeys): Promise<unknown[]> {
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	const value = keys ? await decryptJson(text, keys.key, context(keys, shardObject(generation, keys, shard))) : JSON.parse(text) as unknown;
	const body = value as Partial<ShardBody> | null;
	if (!body || body.format !== READING_INDEX_FORMAT || body.shard !== shard || !Array.isArray(body.cards)) throw new Error('Reading index shard is unreadable.');
	for (const card of body.cards as unknown[]) {
		const path = (card as { path?: unknown } | null)?.path;
		if (typeof path !== 'string' || readingIndexShard(path) !== shard) throw new Error('Reading index shard is unreadable.');
	}
	return body.cards;
}

/** Seals what the server must not change: the shards, their plaintext hashes and basis. */
export async function sealReadingIndexManifest(fields: SealedFields, keys: ReadingIndexKeys): Promise<string> {
	return encryptJson(fields, keys.key, context(keys, manifestObject(fields.generation, keys)));
}

/** Each shard's plaintext hash: equal to the stored hash in an unencrypted vault, and from the
 * sealed fields in an encrypted one, which must match the published ones. */
export async function readingIndexContentHashes(manifest: ReadingIndexManifest, keys?: ReadingIndexKeys): Promise<string[]> {
	if (!keys) return manifest.shards;
	if (manifest.keyGeneration !== keys.keyGeneration || !manifest.sealed) throw new Error('Reading index uses other keys.');
	const sealed = await decryptJson(manifest.sealed, keys.key, context(keys, manifestObject(manifest.generation, keys))) as Partial<SealedFields> | null;
	if (!sealed || sealed.generation !== manifest.generation || sealed.basis !== manifest.basis || !Array.isArray(sealed.shards) || !Array.isArray(sealed.content)
		|| sealed.shards.length !== READING_INDEX_SHARDS || sealed.content.length !== READING_INDEX_SHARDS
		|| sealed.shards.some((hash, index) => hash !== manifest.shards[index]) || !sealed.content.every(hash => typeof hash === 'string')) {
		throw new Error('Reading index manifest failed verification.');
	}
	return sealed.content;
}
