import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { LocalManifest } from './manifest';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

type MockAdapter = {
	list: ReturnType<typeof vi.fn>;
	exists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
	read: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
	write: ReturnType<typeof vi.fn<(path: string, data: string) => Promise<void>>>;
	remove: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
};

function createMockAdapter(): MockAdapter {
	return {
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
		read: vi.fn(),
		write: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
	};
}

function createLocalManifest(adapter: MockAdapter): LocalManifest {
	const app = {
		vault: { adapter },
	} as unknown as App;

	const pluginManifest = {
		dir: PLUGIN_DIR,
	} as unknown as PluginManifest;

	return new LocalManifest(app, pluginManifest);
}

describe('LocalManifest', () => {
	let adapter: MockAdapter;
	let manifest: LocalManifest;

	beforeEach(() => {
		adapter = createMockAdapter();
		manifest = createLocalManifest(adapter);
	});

	it.each(['__proto__', 'constructor', 'toString'])('persists, reloads and removes the literal filename %s', async path => {
		const disk = new Map<string, string>();
		adapter.exists.mockImplementation(async file => disk.has(file));
		adapter.read.mockImplementation(async file => disk.get(file)!);
		adapter.write.mockImplementation(async (file, data) => { disk.set(file, data); });
		adapter.remove.mockImplementation(async file => { disk.delete(file); });
		const entry = { hash: 'f'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z', revision: 'r1' };
		expect(manifest.hasFile(path)).toBe(false);
		expect(manifest.getEntry(path)).toBeUndefined();
		manifest.setEntry(path, entry);
		expect(manifest.hasFile(path)).toBe(true);
		await manifest.save();

		const reloaded = createLocalManifest(adapter);
		await reloaded.load();
		expect(reloaded.getAllPaths()).toEqual([path]);
		expect(reloaded.getEntry(path)).toEqual(entry);
		expect(reloaded.hashMatches(path, entry.hash)).toBe(true);
		reloaded.setEntry(path, { hash: entry.hash, size: entry.size, modified: entry.modified });
		expect(reloaded.getEntry(path)?.revision).toBe('r1');
		reloaded.removeEntry(path);
		await reloaded.save();

		const removed = createLocalManifest(adapter);
		await removed.load();
		expect(removed.getFileCount()).toBe(0);
		expect(removed.getEntry(path)).toBeUndefined();
		expect(removed.hasFile(path)).toBe(false);
		expect(removed.hashMatches(path, entry.hash)).toBe(false);
	});

	it('preserves literal prototype names when recovering a newer temporary checkpoint', async () => {
		const paths = ['__proto__', 'constructor', 'toString'];
		const files = Object.fromEntries(paths.map(path => [path, { hash: 'a'.repeat(64), size: 1, modified: '2026-09-09T00:00:00Z' }]));
		adapter.exists.mockResolvedValue(true);
		adapter.read.mockImplementation(async path => JSON.stringify({
			version: 1,
			generation: path.endsWith('.tmp') ? 2 : 1,
			files: path.endsWith('.tmp') ? files : {},
		}));
		await manifest.load();
		expect(manifest.getAllPaths()).toEqual(paths);
		const promoted = JSON.parse(adapter.write.mock.calls[0]![1]) as { files: Record<string, unknown> };
		expect(Object.keys(promoted.files)).toEqual(paths);
		expect(promoted.files).toEqual(files);
	});

	it('keeps replacement and cleared manifests free of inherited file entries', () => {
		const entry = { hash: 'f'.repeat(64), size: 1, modified: '2026-09-09T00:00:00Z' };
		const files = Object.create({ inherited: entry }) as Record<string, typeof entry>;
		Object.defineProperty(files, '__proto__', { value: entry, enumerable: true });
		manifest.replaceManifest({ version: 1, files });
		expect(manifest.getAllPaths()).toEqual(['__proto__']);
		expect(manifest.getEntry('__proto__')).toEqual(entry);
		expect(manifest.getEntry('inherited')).toBeUndefined();
		expect(manifest.hasFile('constructor')).toBe(false);
		manifest.clear();
		for (const path of ['__proto__', 'constructor', 'toString']) {
			expect(manifest.hasFile(path)).toBe(false);
			expect(manifest.getEntry(path)).toBeUndefined();
		}
	});

	it('persists mutations made while an earlier checkpoint is being written', async () => {
		const entry = { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z' };
		manifest.setEntry('a.md', entry);
		adapter.write.mockImplementationOnce(async () => {
			manifest.setEntry('b.md', { ...entry, hash: 'b'.repeat(64) });
		});
		await manifest.save();
		const mainWrites = adapter.write.mock.calls.filter(([path]) => path.endsWith('.json'));
		expect(mainWrites).toHaveLength(2);
		expect(JSON.parse(mainWrites[1]![1])).toMatchObject({ generation: 2, files: { 'b.md': { hash: 'b'.repeat(64) } } });
	});

	it('serializes overlapping saves', async () => {
		let active = 0;
		let peak = 0;
		adapter.write.mockImplementation(async () => {
			peak = Math.max(peak, ++active);
			await Promise.resolve();
			await Promise.resolve();
			active--;
		});
		manifest.setEntry('a.md', { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z' });
		await Promise.all([manifest.save(), manifest.save(), manifest.save()]);
		expect(peak).toBe(1);
		expect(adapter.write).toHaveBeenCalledTimes(2);
	});

	it.each([[1, 2, 'b'.repeat(64)], [2, 1, 'a'.repeat(64)]])('selects the newest valid checkpoint (%i, %i)', async (mainGeneration, tmpGeneration, expected) => {
		adapter.exists.mockResolvedValue(true);
		adapter.read.mockImplementation(async path => JSON.stringify({
			version: 1,
			generation: path.endsWith('.tmp') ? tmpGeneration : mainGeneration,
			files: { 'a.md': { hash: path.endsWith('.tmp') ? 'b'.repeat(64) : 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z' } },
		}));
		await manifest.load();
		expect(manifest.getEntry('a.md')?.hash).toBe(expected);
	});

	it('retains a newer checkpoint if recovery promotion fails', async () => {
		adapter.exists.mockResolvedValue(true);
		adapter.read.mockImplementation(async path => JSON.stringify({ version: 1, generation: path.endsWith('.tmp') ? 2 : 1, files: {} }));
		adapter.write.mockRejectedValueOnce(new Error('Disk full'));
		await expect(manifest.load()).rejects.toThrow('Disk full');
		expect(adapter.remove).not.toHaveBeenCalled();
	});

	it('retries a failed checkpoint without losing its dirty state', async () => {
		manifest.setEntry('a.md', { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z' });
		adapter.write.mockRejectedValueOnce(new Error('Disk full'));
		await expect(manifest.save()).rejects.toThrow('Disk full');
		await manifest.save();
		expect(adapter.write).toHaveBeenCalledTimes(3);
	});

	it('loads persisted manifest data when file exists', async () => {
		adapter.exists.mockImplementation((path: string) =>
			Promise.resolve(path.endsWith('file-manifest.json') && !path.endsWith('.tmp')),
		);
		adapter.read.mockResolvedValue(
			JSON.stringify({
				version: 1,
				generation: 1,
				lastSeq: 12,
				files: {
					'note.md': {
						hash: 'c'.repeat(64),
						size: 10,
						modified: '2026-02-06T12:00:00.000Z',
					},
				},
			}),
		);

		await manifest.load();

		expect(manifest.getEntry('note.md')).toEqual({
			hash: 'c'.repeat(64),
			size: 10,
			modified: '2026-02-06T12:00:00.000Z',
		});
		expect(manifest.getManifest().lastSeq).toBe(12);
	});

	it('rejects and preserves an unsupported checkpoint', async () => {
		adapter.exists.mockImplementation((path: string) =>
			Promise.resolve(path.endsWith('file-manifest.json') && !path.endsWith('.tmp')),
		);
		adapter.read.mockResolvedValue(JSON.stringify({ invalid: true }));

		await expect(manifest.load()).rejects.toThrow();
		expect(adapter.remove).not.toHaveBeenCalled();
		expect(adapter.write).not.toHaveBeenCalled();

		expect(manifest.getManifest()).toEqual({ version: 1, files: {} });
	});

	it('rejects malformed persisted entries without adopting a partial checkpoint', async () => {
		adapter.exists.mockImplementation(async path => path.endsWith('/file-manifest.json'));
		adapter.read.mockResolvedValue(JSON.stringify({ version: 1, generation: 1, lastSeq: 42,
			files: { 'good.md': { hash: 'a'.repeat(64), size: 1, modified: '2026-09-09' },
				'bad.md': { hash: 'b'.repeat(64), size: -1, modified: '2026-09-09' } } }));
		await expect(manifest.load()).rejects.toThrow();
		expect(manifest.getFileCount()).toBe(0);
		expect(adapter.write).not.toHaveBeenCalled();
		expect(adapter.remove).not.toHaveBeenCalled();
	});

	it('recovers from tmp file when main file is corrupt', async () => {
		const validManifest = JSON.stringify({
			version: 1,
			generation: 1,
			files: { 'a.md': { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00.000Z' } },
		});
		adapter.exists.mockImplementation((path: string) => Promise.resolve(true));
		adapter.read.mockImplementation((path: string) => {
			if (path.endsWith('.tmp')) return Promise.resolve(validManifest);
			return Promise.resolve('{corrupt');
		});

		await manifest.load();

		expect(manifest.getEntry('a.md')).toEqual({ hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00.000Z' });
		// Verify it promoted tmp to main
		expect(adapter.write).toHaveBeenCalledWith(
			`${PLUGIN_DIR}/file-manifest.json`,
			expect.any(String),
		);
	});

	it('does not write when manifest is not dirty', async () => {
		await manifest.save();
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it('writes once when changed, then resets dirty state', async () => {
		manifest.setEntry('note.md', {
			hash: '1'.repeat(64),
			size: 20,
			modified: '2026-02-06T12:00:00.000Z',
		});

		await manifest.save();
		await manifest.save();

		// save writes tmp then main (2 writes per save), plus remove of tmp
		expect(adapter.write).toHaveBeenCalledTimes(2);
		expect(adapter.write).toHaveBeenCalledWith(
			`${PLUGIN_DIR}/file-manifest.json.tmp`,
			expect.any(String),
		);
		expect(adapter.write).toHaveBeenCalledWith(
			`${PLUGIN_DIR}/file-manifest.json`,
			expect.any(String),
		);
	});

	it('persists removals after delete', async () => {
		manifest.setEntry('note.md', {
			hash: '1'.repeat(64),
			size: 20,
			modified: '2026-02-06T12:00:00.000Z',
		});
		await manifest.save();

		manifest.removeEntry('note.md');
		await manifest.save();

		// Find the last write to the main manifest path (not tmp)
		const mainWrites = adapter.write.mock.calls.filter(
			(call: [string, string]) => call[0].endsWith('file-manifest.json') && !call[0].endsWith('.tmp'),
		);
		const lastWrite = mainWrites.at(-1);
		expect(lastWrite).toBeDefined();
		const [, lastPayload] = lastWrite!;
		expect(JSON.parse(lastPayload)).toEqual({
			generation: 2,
			version: 2,
			files: {},
		});
	});

	it('rejects an invalid replacement without changing current authority', () => {
		const entry = { hash: 'a'.repeat(64), size: 1, modified: '2026-09-09' };
		manifest.setEntry('original.md', entry);
		expect(() => manifest.replaceManifest({ version: 1, files: { 'bad.md': { ...entry, size: -1 } }, lastSeq: -5 })).toThrow();
		expect(manifest.getManifest().files).toEqual({ 'original.md': entry });
	});
});
