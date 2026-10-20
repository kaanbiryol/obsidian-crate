import { describe, expect, it, vi } from 'vitest';
import { MarkdownBaseCache, PRUNE_INTERVAL_MS } from './markdown-base-cache';
import type { FileEntry } from '../protocol/sync-types';
import { sha256Hex } from '../platform/sha256';

const PLUGIN_DIR = '.vault-config/plugins/crate';

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
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
		const hash = await sha256Hex(content);
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
		const hash = await sha256Hex(toArrayBuffer('the complete common base'));
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${hash}.md`, toArrayBuffer('the complete'));
		expect(await cache.readBase('notes/a.md', hash)).toBeNull();
	});

	it('repairs a corrupt cache from an unchanged local file during seeding', async () => {
		const { cache, files } = createCacheHarness();
		const content = toArrayBuffer('the complete common base');
		const hash = await sha256Hex(content);
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
		const hash = await sha256Hex(content);

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
		const matchingHash = await sha256Hex(matching);
		const oldChangedHash = await sha256Hex(toArrayBuffer('old\n'));
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
		const keptHash = await sha256Hex(kept);
		const removedHash = await sha256Hex(removed);
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${keptHash}.md`, kept);
		files.set(`${PLUGIN_DIR}/markdown-base-cache/${removedHash}.md`, removed);

		await cache.pruneReferencedHashes(new Set([keptHash]));

		expect(files.has(`${PLUGIN_DIR}/markdown-base-cache/${keptHash}.md`)).toBe(true);
		expect(files.has(`${PLUGIN_DIR}/markdown-base-cache/${removedHash}.md`)).toBe(false);
	});
});

it('coalesces duplicate cache writes and retries failed writes', async () => {
    const { cache, adapter } = createCacheHarness();
    const content = toArrayBuffer('same content');
    const hash = await sha256Hex(content);
    await Promise.all([cache.putBase('a.md', hash, content), cache.putBase('b.md', hash, content)]);
    await cache.putBase('a.md', hash, content);
    expect(adapter.writeBinary).toHaveBeenCalledTimes(1);

    const next = toArrayBuffer('next content');
    const nextHash = await sha256Hex(next);
    adapter.writeBinary.mockRejectedValueOnce(new Error('disk unavailable'));
    await cache.putBase('a.md', nextHash, next);
    await cache.putBase('a.md', nextHash, next);
    expect(adapter.writeBinary).toHaveBeenCalledTimes(3);
});

it('rewrites a cache entry after pruning it', async () => {
    const { cache, adapter } = createCacheHarness();
    const content = toArrayBuffer('content');
    const hash = await sha256Hex(content);
    await cache.putBase('a.md', hash, content);
    await cache.pruneReferencedHashes(new Set());
    await cache.putBase('a.md', hash, content);
    expect(adapter.writeBinary).toHaveBeenCalledTimes(2);
});

it('checks a complete cache with one listing instead of an exists call per note', async () => {
    const { cache, adapter, files } = createCacheHarness();
    const entries: Record<string, FileEntry> = {};
    for (let i = 0; i < 1000; i++) {
        const hash = i.toString(16).padStart(64, '0');
        entries[`notes/${i}.md`] = { hash, size: 4, modified: '2026-01-01' };
        files.set(`${PLUGIN_DIR}/markdown-base-cache/${hash}.md`, toArrayBuffer('base'));
    }
    await cache.seedFromManifest(createManifest(entries), {
        isDestroyed: () => false,
        runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
    });
    // Before: 1,000 exists() calls plus a second listing for the prune.
    expect(adapter.exists).not.toHaveBeenCalled();
    expect(adapter.list).toHaveBeenCalledOnce();
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
});

it('prunes after syncs at most once per interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        const { cache, adapter, files } = createCacheHarness();
        const orphan = `${PLUGIN_DIR}/markdown-base-cache/${'b'.repeat(64)}.md`;
        files.set(orphan, toArrayBuffer('old base'));
        const manifest = createManifest({});

        await cache.pruneUnreferenced(manifest);
        expect(files.has(orphan)).toBe(false);
        files.set(orphan, toArrayBuffer('old base'));
        await cache.pruneUnreferenced(manifest);
        expect(adapter.list).toHaveBeenCalledOnce();
        expect(files.has(orphan)).toBe(true);

        vi.advanceTimersByTime(PRUNE_INTERVAL_MS);
        await cache.pruneUnreferenced(manifest);
        expect(adapter.list).toHaveBeenCalledTimes(2);
        expect(files.has(orphan)).toBe(false);
    } finally { vi.useRealTimers(); }
});
