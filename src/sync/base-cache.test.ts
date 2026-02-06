import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseCache } from './base-cache';
import type { DataAdapter } from 'obsidian';

function createMockAdapter(): DataAdapter {
	return {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
		readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
		exists: vi.fn().mockResolvedValue(false),
		remove: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
	} as unknown as DataAdapter;
}

const BASES_DIR = '.obsidian/plugins/obsidian-crate/bases';

describe('BaseCache', () => {
	let adapter: DataAdapter;
	let cache: BaseCache;

	beforeEach(() => {
		adapter = createMockAdapter();
		cache = new BaseCache(adapter);
	});

	it('saveBase + getBase round-trips content', async () => {
		const content = new TextEncoder().encode('hello world').buffer;
		vi.mocked(adapter.exists).mockResolvedValue(true);
		vi.mocked(adapter.readBinary).mockResolvedValue(content);

		await cache.saveBase('notes/test.md', content);
		const result = await cache.getBase('notes/test.md');

		expect(adapter.writeBinary).toHaveBeenCalledWith(
			`${BASES_DIR}/notes/test.md`,
			content,
		);
		expect(result).toBe(content);
	});

	it('saveBase skips non-mergeable files', async () => {
		const content = new ArrayBuffer(8);
		await cache.saveBase('images/photo.png', content);

		expect(adapter.writeBinary).not.toHaveBeenCalled();
		expect(adapter.mkdir).not.toHaveBeenCalled();
	});

	it('getBase returns null when no base exists', async () => {
		vi.mocked(adapter.exists).mockResolvedValue(false);
		const result = await cache.getBase('notes/test.md');
		expect(result).toBeNull();
	});

	it('removeBase deletes existing base', async () => {
		vi.mocked(adapter.exists).mockResolvedValue(true);
		await cache.removeBase('notes/test.md');

		expect(adapter.remove).toHaveBeenCalledWith(`${BASES_DIR}/notes/test.md`);
	});

	it('removeBase is a no-op when base is missing', async () => {
		vi.mocked(adapter.exists).mockResolvedValue(false);
		await cache.removeBase('notes/test.md');

		expect(adapter.remove).not.toHaveBeenCalled();
	});

	it('clear recursively removes bases directory', async () => {
		vi.mocked(adapter.exists).mockResolvedValue(true);
		vi.mocked(adapter.list).mockResolvedValueOnce({
			files: [`${BASES_DIR}/a.md`],
			folders: [`${BASES_DIR}/sub`],
		}).mockResolvedValueOnce({
			files: [`${BASES_DIR}/sub/b.md`],
			folders: [],
		});

		await cache.clear();

		expect(adapter.remove).toHaveBeenCalledWith(`${BASES_DIR}/a.md`);
		expect(adapter.remove).toHaveBeenCalledWith(`${BASES_DIR}/sub/b.md`);
		expect(adapter.rmdir).toHaveBeenCalledWith(`${BASES_DIR}/sub`, false);
		expect(adapter.rmdir).toHaveBeenCalledWith(BASES_DIR, false);
	});

	it('clear is a no-op when directory is missing', async () => {
		vi.mocked(adapter.exists).mockResolvedValue(false);
		await cache.clear();

		expect(adapter.list).not.toHaveBeenCalled();
		expect(adapter.rmdir).not.toHaveBeenCalled();
	});
});
