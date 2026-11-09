import { validateReadingMetadata } from '../core/model';
import { parseReadingNote } from '../core/notes';
import {
	buildReadingIndexShards, readingIndexContentHashes, sealReadingIndexManifest, storedReadingIndexShard,
	type ReadingIndexCard, type ReadingIndexKeys,
} from '../core/card-index';
import { sha256Hex } from '@/platform/sha256';
import { READING_INDEX_EMPTY_SHARD, READING_INDEX_FORMAT, READING_INDEX_SHARDS, readingIndexShard, type ReadingIndexManifest } from '@/protocol/reading-index';
import type { ReadingFile, ReadingVault } from './library';

/** The server side of publishing; `SyncApiClient` implements it. */
export interface ReadingIndexServer {
	getReadingIndex(): Promise<{ manifest: ReadingIndexManifest; etag: string } | null>;
	putReadingIndexShard(hash: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
	putReadingIndex(manifest: ReadingIndexManifest, expected: string | null): Promise<boolean>;
	readingIndexKeys(): ReadingIndexKeys | null;
	opaqueServerPath(path: string): Promise<string | undefined>;
}
type PublisherVault = Pick<ReadingVault, 'files' | 'read' | 'file' | 'cachedProperties'>;
export type ReadingIndexOutcome = 'published' | 'current' | 'conflict' | 'behind';
/** With unchanged cards, the manifest moves its basis forward only this far behind, so the
 * web app's tail stays short without a write for every sync. */
const BASIS_REFRESH = 500;

/**
 * Builds the Reading card index from Obsidian's frontmatter cache and publishes the shards
 * that changed. It reads a note only when the cache has not indexed it. Cards keep their
 * shard between publishes, so a change rebuilds one shard.
 */
export class ReadingIndexPublisher {
	// Cards by shard and path; null until the first publish lists the folder.
	private shards: Array<Map<string, ReadingIndexCard>> | null = null;
	private dirty = new Set<string>();
	constructor(private vault: PublisherVault, readonly folder: string, private skipped: (path: string) => boolean = () => false) {}

	private isNotePath(path: string): boolean { return path.startsWith(`${this.folder}/`) && /\.md$/i.test(path); }
	/** Notes that changed. A path that is not a note, such as a renamed folder, lists the folder again. */
	changed(paths: Iterable<string>): void {
		for (const path of paths) {
			if (this.isNotePath(path)) this.dirty.add(path);
			else this.shards = null;
		}
	}
	get pending(): boolean { return this.shards === null || this.dirty.size > 0; }

	private async card(file: ReadingFile, server: ReadingIndexServer): Promise<ReadingIndexCard | null> {
		if (this.skipped(file.path)) return null;
		let metadata = null;
		const properties = this.vault.cachedProperties?.(file);
		if (properties && Object.prototype.hasOwnProperty.call(properties, 'crate_reading_version')) {
			try { metadata = validateReadingMetadata(properties); } catch { metadata = null; }
		}
		// Not indexed yet or not valid in the cache: the strict parser decides.
		if (!metadata && properties === undefined) {
			try { metadata = parseReadingNote(await this.vault.read(file)); } catch { metadata = null; }
		}
		if (!metadata) return null;
		const wire = await server.opaqueServerPath(file.path);
		return { ...metadata, tags: [...metadata.tags], path: file.path, ...(wire ? { wire } : {}) };
	}

	private async refreshCards(server: ReadingIndexServer): Promise<Set<number>> {
		const touched = new Set<number>();
		if (!this.shards) {
			const shards = Array.from({ length: READING_INDEX_SHARDS }, () => new Map<string, ReadingIndexCard>());
			for (const file of this.vault.files()) {
				if (!this.isNotePath(file.path)) continue;
				const card = await this.card(file, server);
				if (card) shards[readingIndexShard(card.path)]!.set(card.path, card);
			}
			this.shards = shards;
			this.dirty.clear();
			for (let shard = 0; shard < shards.length; shard++) touched.add(shard);
			return touched;
		}
		const paths = [...this.dirty];
		this.dirty.clear();
		for (const path of paths) {
			const shard = readingIndexShard(path);
			touched.add(shard);
			const file = this.vault.file ? this.vault.file(path) ?? undefined : this.vault.files().find(entry => entry.path === path);
			const card = file ? await this.card(file, server) : null;
			if (card) this.shards[shard]!.set(path, card); else this.shards[shard]!.delete(path);
		}
		return touched;
	}

	/**
	 * Publishes cards for `basis`, the changelog position this device's notes match, over the
	 * manifest it reads. A newer manifest from another device wins; a conflict leaves the
	 * changes pending for the next attempt.
	 */
	async publish(server: ReadingIndexServer, generation: string, basis: number): Promise<ReadingIndexOutcome> {
		const restore = new Set(this.dirty), full = this.shards === null;
		try {
			await this.refreshCards(server);
			const keys = server.readingIndexKeys() ?? undefined;
			const built = await buildReadingIndexShards(this.shards!.flatMap(shard => [...shard.values()]));
			const remote = await server.getReadingIndex();
			if (remote && remote.manifest.basis > basis) throw new Behind();
			let content: string[] | null = null;
			if (remote) { try { content = await readingIndexContentHashes(remote.manifest, keys); } catch { content = null; } }
			const changed = built.flatMap((shard, index) => !content || content[index] !== shard.content ? [index] : []);
			if (remote && !changed.length && basis - remote.manifest.basis < BASIS_REFRESH) return 'current';
			const shards = remote && content ? [...remote.manifest.shards] : built.map(() => READING_INDEX_EMPTY_SHARD);
			for (const index of changed) {
				const { json } = built[index]!;
				if (!json) { shards[index] = READING_INDEX_EMPTY_SHARD; continue; }
				const bytes = await storedReadingIndexShard(json, index, generation, keys);
				const hash = await sha256Hex(bytes);
				await server.putReadingIndexShard(hash, bytes);
				shards[index] = hash;
			}
			const manifest: ReadingIndexManifest = { format: READING_INDEX_FORMAT, generation, basis, shards,
				...(keys ? { keyGeneration: keys.keyGeneration, sealed: await sealReadingIndexManifest({ generation, basis, shards, content: built.map(shard => shard.content) }, keys) } : {}) };
			if (await server.putReadingIndex(manifest, remote?.etag ?? null)) return 'published';
			throw new Conflict();
		} catch (error) {
			// Not published: the same notes are rebuilt next time.
			for (const path of restore) this.dirty.add(path);
			if (full) this.shards = null;
			if (error instanceof Behind) return 'behind';
			if (error instanceof Conflict) return 'conflict';
			throw error;
		}
	}
}
class Behind extends Error {}
class Conflict extends Error {}
