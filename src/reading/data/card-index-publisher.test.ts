import { describe, expect, it } from 'vitest';
import { ReadingIndexPublisher, type ReadingIndexServer } from './card-index-publisher';
import type { ReadingFile } from './library';
import { createReadingNote } from '../core/notes';
import { readReadingFrontmatter } from '../core/frontmatter';
import { openReadingIndexShard, readingIndexContentHashes } from '../core/card-index';
import { generateEncryptionSecret, importEncryptionSecret } from '@/encryption/envelope';
import { sha256Hex } from '@/platform/sha256';
import { READING_INDEX_SHARDS, readingIndexShard, type ReadingIndexManifest } from '@/protocol/reading-index';

const note = (index: number, title = `Article ${index}`) => createReadingNote({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, url: `https://example.invalid/${index}`, title, savedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() });

function vault(initial: Record<string, string>) {
	const contents = new Map(Object.entries(initial)), properties = new Map<string, Record<string, unknown>>();
	const reads: string[] = [];
	const index = (path: string) => properties.set(path, readReadingFrontmatter(contents.get(path)!)!.value);
	for (const path of contents.keys()) index(path);
	const file = (path: string): ReadingFile => ({ path, size: contents.get(path)!.length, modifiedAt: 1 });
	return {
		reads, index,
		write: (path: string, content: string) => { contents.set(path, content); index(path); },
		remove: (path: string) => { contents.delete(path); properties.delete(path); },
		fake: {
			files: () => [...contents.keys()].map(file), file: (path: string) => contents.has(path) ? file(path) : null,
			cachedProperties: (current: ReadingFile) => properties.get(current.path),
			read: async (current: ReadingFile) => { reads.push(current.path); return contents.get(current.path)!; },
		},
	};
}

/** The server's side: content-addressed shards and one conditional manifest. */
function server(keys: Awaited<ReturnType<typeof encryptionKeys>> | null = null) {
	const shards = new Map<string, Uint8Array>(), uploads: string[] = [];
	const race = { lose: false };
	let stored: { manifest: ReadingIndexManifest; etag: string } | null = null, version = 0;
	const api: ReadingIndexServer = {
		getReadingIndex: async () => stored,
		putReadingIndexShard: async (hash, bytes) => { expect(await sha256Hex(bytes)).toBe(hash); shards.set(hash, bytes); uploads.push(hash); },
		putReadingIndex: async (manifest, expected) => {
			if (race.lose || (stored?.etag ?? null) !== expected) return false;
			for (const hash of manifest.shards) if (hash) expect(shards.has(hash)).toBe(true);
			stored = { manifest, etag: `v${++version}` };
			return true;
		},
		readingIndexKeys: () => keys,
		opaqueServerPath: async path => path.endsWith('Sealed.md') ? 'Reading/opaque-name.md' : undefined,
	};
	return { api, shards, uploads, race, manifest: () => stored?.manifest, replace: (manifest: ReadingIndexManifest) => { stored = { manifest, etag: `v${++version}` }; } };
}
const encryptionKeys = async () => ({ vaultId: 'vault', key: await importEncryptionSecret(generateEncryptionSecret()), keyGeneration: 3 });
async function cards(remote: ReturnType<typeof server>, keys?: Awaited<ReturnType<typeof encryptionKeys>>) {
	const manifest = remote.manifest()!;
	const opened = await Promise.all(manifest.shards.map(async (hash, shard) => hash ? openReadingIndexShard(remote.shards.get(hash)! as Uint8Array<ArrayBuffer>, shard, 'gen', keys) : []));
	return opened.flat() as Array<{ title: string; path: string; wire?: string }>;
}

describe('Reading card index publisher', () => {
	it('publishes every card from the cache without reading notes, then only a changed shard', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2), 'Reading/C.md': note(3) });
		const remote = server(), publisher = new ReadingIndexPublisher(h.fake, 'Reading');
		expect(await publisher.publish(remote.api, 'gen', 10)).toBe('published');
		expect(h.reads).toEqual([]);
		const shardsWithCards = new Set(['Reading/A.md', 'Reading/B.md', 'Reading/C.md'].map(readingIndexShard)).size;
		expect(remote.uploads).toHaveLength(shardsWithCards);
		expect((await cards(remote)).map(card => card.title).sort()).toEqual(['Article 1', 'Article 2', 'Article 3']);
		// Nothing changed: no upload, no manifest write.
		remote.uploads.length = 0;
		expect(publisher.pending).toBe(false);
		expect(await publisher.publish(remote.api, 'gen', 11)).toBe('current');
		expect(remote.uploads).toEqual([]);
		h.write('Reading/B.md', note(2, 'Renamed'));
		publisher.changed(['Reading/B.md']);
		expect(await publisher.publish(remote.api, 'gen', 12)).toBe('published');
		expect(remote.uploads).toHaveLength(1);
		expect(remote.manifest()!.basis).toBe(12);
		expect((await cards(remote)).find(card => card.path === 'Reading/B.md')?.title).toBe('Renamed');
		h.remove('Reading/C.md');
		publisher.changed(['Reading/C.md']);
		await publisher.publish(remote.api, 'gen', 13);
		expect((await cards(remote)).map(card => card.path).sort()).toEqual(['Reading/A.md', 'Reading/B.md']);
	});

	it('leaves out notes that are not imported or that the background work flagged', async () => {
		const h = vault({ 'Reading/A.md': note(1), 'Reading/B.md': note(2), 'Reading/Clip.md': '---\nsource: https://example.invalid/clip\n---\nClip.' });
		const remote = server(), publisher = new ReadingIndexPublisher(h.fake, 'Reading', path => path === 'Reading/B.md');
		await publisher.publish(remote.api, 'gen', 1);
		expect((await cards(remote)).map(card => card.path)).toEqual(['Reading/A.md']);
	});

	it('yields to a newer manifest and keeps a lost race pending', async () => {
		const h = vault({ 'Reading/A.md': note(1) });
		const remote = server(), publisher = new ReadingIndexPublisher(h.fake, 'Reading');
		remote.replace({ format: 1, generation: 'gen', basis: 50, shards: Array.from({ length: READING_INDEX_SHARDS }, () => '') });
		expect(await publisher.publish(remote.api, 'gen', 40)).toBe('behind');
		expect(publisher.pending).toBe(true);
		remote.race.lose = true;
		expect(await publisher.publish(remote.api, 'gen', 60)).toBe('conflict');
		expect(publisher.pending).toBe(true);
		remote.race.lose = false;
		expect(await publisher.publish(remote.api, 'gen', 61)).toBe('published');
	});

	it('seals shards and the manifest in an encrypted vault, with the server path of a sealed note', async () => {
		const keys = await encryptionKeys();
		const h = vault({ 'Reading/A.md': note(1, 'Private title'), 'Reading/Sealed.md': note(2) });
		const remote = server(keys), publisher = new ReadingIndexPublisher(h.fake, 'Reading');
		await publisher.publish(remote.api, 'gen', 5);
		for (const bytes of remote.shards.values()) expect(new TextDecoder().decode(bytes)).not.toContain('Private title');
		const opened = await cards(remote, keys);
		expect(opened.find(card => card.path === 'Reading/Sealed.md')?.wire).toBe('Reading/opaque-name.md');
		expect(opened.find(card => card.path === 'Reading/A.md')?.wire).toBeUndefined();
		const manifest = remote.manifest()!;
		await expect(readingIndexContentHashes(manifest, keys)).resolves.toHaveLength(READING_INDEX_SHARDS);
		// The server cannot point the web app at other shards or another basis.
		const swapped = [...manifest.shards].reverse();
		await expect(readingIndexContentHashes({ ...manifest, shards: swapped }, keys)).rejects.toThrow('verification');
		await expect(readingIndexContentHashes({ ...manifest, basis: 99 }, keys)).rejects.toThrow('verification');
		// An unchanged library publishes nothing more, even though every envelope is random.
		remote.uploads.length = 0;
		expect(await publisher.publish(remote.api, 'gen', 6)).toBe('current');
		expect(remote.uploads).toEqual([]);
	});
});
