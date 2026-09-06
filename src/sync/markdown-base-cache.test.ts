import { describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import { MarkdownBaseCache } from './markdown-base-cache';
import type { FileEntry } from '../protocol/sync-types';

const PLUGIN_DIR = '.vault-config/plugins/crate';

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fromArrayBuffer(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
}

function createCacheHarness() {
	const files = new Map<string, ArrayBuffer>();
	const adapter = {
		exists: vi.fn(async (path: string) => files.has(path)),
		readBinary: vi.fn(async (path: string) => {
			const content = files.get(path);
			if (!content) {
				throw new Error(`missing ${path}`);
			}
			return content;
		}),
		writeBinary: vi.fn(async (path: string, content: ArrayBuffer) => {
			files.set(path, content);
		}),
		mkdir: vi.fn(async () => {}),
		list: vi.fn(async (path: string) => ({
			files: Array.from(files.keys()).filter((filePath) => filePath.startsWith(`${path}/`)),
			folders: [],
		})),
		remove: vi.fn(async (path: string) => {
			files.delete(path);
		}),
	};
	const cache = new MarkdownBaseCache({
		vault: { adapter },
	} as never, { dir: PLUGIN_DIR } as never);

	return { adapter, cache, files };
}

function createManifest(entries: Record<string, FileEntry>) {
	return {
		getAllPaths: () => Object.keys(entries),
		getEntry: (path: string) => entries[path],
	};
}

describe('MarkdownBaseCache', () => {
	it('does not read or hash existing cache contents during background seeding', async () => {
		const { cache, files, adapter } = createCacheHarness();
		const content = toArrayBuffer('unchanged');
		const hash = await computeHash(content);
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${hash}.md`, content);
		await cache.seedFromManifest(createManifest({ 'a.md': { hash, size: content.byteLength, modified: '2026-01-01' } }), {
			isDestroyed: () => false,
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
		});
		expect(adapter.readBinary).not.toHaveBeenCalled();
		expect(await cache.readBase('a.md', hash)).toEqual(content);
		expect(adapter.readBinary).toHaveBeenCalledOnce();
	});

	it('stops seeding between bounded batches when destroyed', async () => {
		const { cache, adapter } = createCacheHarness();
		const entry = { hash: 'a'.repeat(64), size: 1, modified: '2026-01-01' };
		const entries = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${i}.md`, entry]));
		let destroyed = false;
		const runConcurrent = vi.fn(async <T>(tasks: Array<() => Promise<T>>) => {
			expect(tasks.length).toBeLessThanOrEqual(32);
			destroyed = true;
			return [] as T[];
		});
		await cache.seedFromManifest(createManifest(entries), {
			isDestroyed: () => destroyed,
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => { await runConcurrent(tasks); return [] as T[]; },
		});
		expect(runConcurrent).toHaveBeenCalledOnce();
		expect(adapter.readBinary).not.toHaveBeenCalled();
		expect(adapter.remove).not.toHaveBeenCalled();
	});
	it('rejects readable but truncated cache contents', async () => {
		const { cache, files } = createCacheHarness();
		const hash = await computeHash(toArrayBuffer('the complete common base'));
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${hash}.md`, toArrayBuffer('the complete'));
		expect(await cache.readBase('notes/a.md', hash)).toBeNull();
	});

	it('repairs a corrupt cache from an unchanged local file during seeding', async () => {
		const { cache, files } = createCacheHarness();
		const content = toArrayBuffer('the complete common base');
		const hash = await computeHash(content);
		files.set('notes/a.md', content);
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${hash}.md`, toArrayBuffer('truncated'));
		expect(await cache.readBase('notes/a.md', hash)).toBeNull();
		await cache.seedFromManifest(createManifest({
			'notes/a.md': { hash, size: content.byteLength, modified: '2026-01-01T00:00:00.000Z' },
		}), {
			isDestroyed: () => false,
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map((task) => task())),
		});
		expect(await cache.readBase('notes/a.md', hash)).toEqual(content);
	});

	it('writes and reads markdown content by hash', async () => {
		const { cache } = createCacheHarness();
		const content = toArrayBuffer('hello\n');
		const hash = await computeHash(content);

		await cache.putBase('notes/a.md', hash, content);
		const result = await cache.readBase('notes/a.md', hash);

		expect(result).not.toBeNull();
		expect(fromArrayBuffer(result as ArrayBuffer)).toBe('hello\n');
	});

	it('skips non-markdown paths and invalid hashes', async () => {
		const { cache, adapter } = createCacheHarness();

		await cache.putBase('notes/a.txt', 'x'.repeat(64), toArrayBuffer('hello'));
		await cache.putBase('notes/a.md', 'not-a-hash', toArrayBuffer('hello'));

		expect(adapter.writeBinary).not.toHaveBeenCalled();
		expect(await cache.readBase('notes/a.txt', 'x'.repeat(64))).toBeNull();
	});

	it('seeds only markdown files whose current content still matches the manifest hash', async () => {
		const { cache, files } = createCacheHarness();
		const matching = toArrayBuffer('same\n');
		const changed = toArrayBuffer('changed\n');
		const matchingHash = await computeHash(matching);
		const oldChangedHash = await computeHash(toArrayBuffer('old\n'));
		files.set('notes/same.md', matching);
		files.set('notes/changed.md', changed);
		files.set('notes/text.txt', toArrayBuffer('same\n'));

		await cache.seedFromManifest(createManifest({
			'notes/same.md': {
				hash: matchingHash,
				size: matching.byteLength,
				modified: '2026-01-01T00:00:00.000Z',
			},
			'notes/changed.md': {
				hash: oldChangedHash,
				size: changed.byteLength,
				modified: '2026-01-01T00:00:00.000Z',
			},
			'notes/text.txt': {
				hash: matchingHash,
				size: matching.byteLength,
				modified: '2026-01-01T00:00:00.000Z',
			},
		}), {
			isDestroyed: () => false,
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map((task) => task())),
		});

		expect(await cache.readBase('notes/same.md', matchingHash)).not.toBeNull();
		expect(await cache.readBase('notes/changed.md', oldChangedHash)).toBeNull();
		expect(await cache.readBase('notes/text.txt', matchingHash)).toBeNull();
	});

	it('prunes cached hashes not referenced by markdown manifest entries', async () => {
		const { cache, files } = createCacheHarness();
		const kept = toArrayBuffer('kept');
		const removed = toArrayBuffer('removed');
		const keptHash = await computeHash(kept);
		const removedHash = await computeHash(removed);
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${keptHash}.md`, kept);
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${removedHash}.md`, removed);

		await cache.pruneReferencedHashes(new Set([keptHash]));

		expect(files.has(`${PLUGIN_DIR}/markdown-base-cache/${keptHash}.md`)).toBe(true);
		expect(files.has(`${PLUGIN_DIR}/markdown-base-cache/${removedHash}.md`)).toBe(false);
	});
});
