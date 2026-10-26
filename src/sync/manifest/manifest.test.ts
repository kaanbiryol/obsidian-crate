import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import type { FileEntry, FileManifest } from '../../protocol/sync-types';
import { LocalManifest } from './manifest';
import { encodeCheckpoint, parseCheckpoint } from './manifest-checkpoint';
import { replayManifestLog } from './manifest-log';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

type MockAdapter = {
	list: ReturnType<typeof vi.fn>;
	exists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
	read: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
	write: ReturnType<typeof vi.fn<(path: string, data: string) => Promise<void>>>;
	remove: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
	append: ReturnType<typeof vi.fn<(path: string, data: string) => Promise<void>>>;
};

function createMockAdapter(): MockAdapter {
	return {
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
		read: vi.fn(),
		write: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
	};
}

/** Rebuild the files the mock adapter received, then load them as a restart would. */
function readPersisted(adapter: MockAdapter): Record<string, unknown> {
	const events = [
		...adapter.write.mock.calls.map((call, index) => ({ order: adapter.write.mock.invocationCallOrder[index]!, apply: (disk: Map<string, string>) => disk.set(call[0], call[1]) })),
		...adapter.append.mock.calls.map((call, index) => ({ order: adapter.append.mock.invocationCallOrder[index]!, apply: (disk: Map<string, string>) => disk.set(call[0], (disk.get(call[0]) ?? '') + call[1]) })),
		...adapter.remove.mock.calls.map((call, index) => ({ order: adapter.remove.mock.invocationCallOrder[index]!, apply: (disk: Map<string, string>) => disk.delete(call[0]) })),
	].sort((a, b) => a.order - b.order);
	const disk = new Map<string, string>();
	for (const event of events) event.apply(disk);
	const checkpoint = parseCheckpoint(JSON.parse(disk.get(`${PLUGIN_DIR}/file-manifest.json`)!));
	const log = disk.get(`${PLUGIN_DIR}/file-manifest.log`);
	if (log) replayManifestLog(checkpoint, log);
	return JSON.parse(encodeCheckpoint(checkpoint)) as Record<string, unknown>;
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

	it('keeps baseline views readonly and preserves entry identity until a controlled replacement', async () => {
		expectTypeOf(manifest.getEntry('note.md')).toEqualTypeOf<Readonly<FileEntry> | undefined>();
		expectTypeOf(manifest.getManifest().files).toEqualTypeOf<Readonly<Record<string, Readonly<FileEntry>>>>();
		expectTypeOf(manifest.getManifest()).toEqualTypeOf<Readonly<Omit<FileManifest, 'files'>> & {
			readonly files: Readonly<Record<string, Readonly<FileEntry>>>;
		}>();
		const original = { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z', revision: 'r1' };
		manifest.setEntry('note.md', original);
		const view = manifest.getManifest();
		const baseline = manifest.getEntry('note.md');
		expect(baseline).toBe(view.files['note.md']);
		expect(baseline).not.toBe(original);
		await manifest.save();
		expect(manifest.getEntry('note.md')).toBe(baseline);

		manifest.setEntry('note.md', { ...original, modified: '2026-01-02T00:00:00Z' });
		expect(manifest.getManifest()).toBe(view);
		expect(manifest.getEntry('note.md')).not.toBe(baseline);
		expect(baseline?.modified).toBe(original.modified);
		await manifest.save();
		const persisted = readPersisted(adapter) as unknown as FileManifest;
		expect(persisted.files['note.md']).toEqual(view.files['note.md']);
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

	it('keeps replacement manifests free of inherited file entries', () => {
		const entry = { hash: 'f'.repeat(64), size: 1, modified: '2026-09-09T00:00:00Z' };
		const files = Object.create({ inherited: entry }) as Record<string, typeof entry>;
		Object.defineProperty(files, '__proto__', { value: entry, enumerable: true });
		manifest.replaceManifest({ version: 1, files });
		expect(manifest.getAllPaths()).toEqual(['__proto__']);
		expect(manifest.getEntry('__proto__')).toEqual(entry);
		expect(manifest.getEntry('inherited')).toBeUndefined();
		expect(manifest.hasFile('constructor')).toBe(false);
	});

	it('persists mutations made while an earlier checkpoint is being written', async () => {
		const entry = { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z' };
		manifest.setEntry('a.md', entry);
		adapter.write.mockImplementationOnce(async () => {
			manifest.setEntry('b.md', { ...entry, hash: 'b'.repeat(64) });
		});
		await manifest.save();
		expect(readPersisted(adapter)).toMatchObject({ generation: 2, files: { 'a.md': { hash: 'a'.repeat(64) }, 'b.md': { hash: 'b'.repeat(64) } } });
	});

	it('stays writable after waiting for queued saves', async () => {
		const entry = { hash: 'a'.repeat(64), size: 5, modified: '2026-01-01T00:00:00Z' };
		manifest.setEntry('a.md', entry);
		void manifest.save();
		await manifest.whenSaved();
		manifest.setEntry('b.md', { ...entry, hash: 'b'.repeat(64) });
		await manifest.save();
		expect(readPersisted(adapter)).toMatchObject({ files: { 'b.md': { hash: 'b'.repeat(64) } } });
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

		expect(readPersisted(adapter)).toEqual({
			generation: 2,
			version: 1,
			files: {},
		});
	});

	it('rejects an invalid replacement without changing current authority', () => {
		const entry = { hash: 'a'.repeat(64), size: 1, modified: '2026-09-09' };
		manifest.setEntry('original.md', entry);
		expect(() => manifest.replaceManifest({ version: 1, files: { 'bad.md': { ...entry, size: -1 } }, lastSeq: -5 })).toThrow();
		expect(manifest.getManifest().files).toEqual({ 'original.md': entry });
	});

	describe('change log', () => {
		const entry = (hash: string) => ({ hash: hash.repeat(64), size: 1, modified: '2026-01-01T00:00:00Z' });
		function diskAdapter(disk: Map<string, string>) {
			adapter.exists.mockImplementation(async path => disk.has(path));
			adapter.read.mockImplementation(async path => disk.get(path)!);
			adapter.write.mockImplementation(async (path, data) => { disk.set(path, data); });
			adapter.append.mockImplementation(async (path, data) => { disk.set(path, (disk.get(path) ?? '') + data); });
			adapter.remove.mockImplementation(async path => { disk.delete(path); });
		}
		const reload = async () => { const next = createLocalManifest(adapter); await next.load(); return next; };
		const log = `${PLUGIN_DIR}/file-manifest.log`, main = `${PLUGIN_DIR}/file-manifest.json`;

		it('appends only changed entries after the first full checkpoint and replays them on load', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			for (let index = 0; index < 5000; index++) manifest.setEntry(`notes/${index}.md`, entry('a'));
			await manifest.save();
			const fullBytes = disk.get(main)!.length;
			adapter.write.mockClear();
			manifest.setEntry('notes/1.md', entry('b'));
			manifest.removeEntry('notes/2.md');
			await manifest.save();
			manifest.setEntry('notes/new.md', entry('c'));
			await manifest.save();
			// Neither save rewrote the checkpoint, and each record stays small.
			expect(adapter.write.mock.calls.filter(([path]) => path === main)).toHaveLength(0);
			expect(disk.get(log)!.length).toBeLessThan(fullBytes / 100);
			const restored = await reload();
			expect(restored.getFileCount()).toBe(5000);
			expect(restored.getEntry('notes/1.md')?.hash).toBe('b'.repeat(64));
			expect(restored.getEntry('notes/2.md')).toBeUndefined();
			expect(restored.getEntry('notes/new.md')?.hash).toBe('c'.repeat(64));
		});

		it('writes recovery state only when it changes', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			for (let index = 0; index < 2000; index++) manifest.setEntry(`notes/${index}.md`, entry('a'));
			await manifest.save();
			manifest.recordRename('notes', 'archive', 'folder');
			await manifest.save();
			for (const hash of ['b', 'c', 'd']) {
				manifest.setEntry('other.md', entry(hash));
				await manifest.save();
			}
			const records = disk.get(log)!.trim().split('\n').slice(1);
			// The rename record carries 2,000 dependencies; later file changes do not repeat them.
			expect(records[0]!.length).toBeGreaterThan(50_000);
			expect(records.slice(1).map(record => record.length).every(length => length < 300)).toBe(true);
			expect(Object.keys((await reload()).getRenameDependencies())).toHaveLength(2000);
		});

		it('replays a cleared recovery field', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			manifest.setEntry('a.md', entry('a'));
			await manifest.save();
			manifest.recordRename('a.md', 'b.md', 'file');
			await manifest.save();
			manifest.removeEntry('a.md');
			await manifest.save();
			expect(disk.get(log)!.trim().split('\n').at(-1)).toContain('"changes":{"renameDependencies":null}');
			expect((await reload()).getRenameDependencies()).toEqual({});
		});

		it('replays records that carry the full recovery state', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			manifest.setEntry('a.md', entry('a'));
			manifest.recordRename('a.md', 'b.md', 'file');
			await manifest.save();
			// An omitted field in a full `state` record means empty, clearing the rename.
			disk.set(log, `{"version":1,"base":1}\n{"generation":2,"set":{},"deleted":[],"state":{}}\n`);
			expect((await reload()).getRenameDependencies()).toEqual({});
		});

		it('drops a torn final record and compacts before appending again', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			manifest.setEntry('a.md', entry('a'));
			await manifest.save();
			manifest.setEntry('b.md', entry('b'));
			await manifest.save();
			disk.set(log, `${disk.get(log)!}{"generation":3,"set":{"c.md"`);
			const restored = await reload();
			expect(restored.getEntry('b.md')).toBeDefined();
			expect(restored.getEntry('c.md')).toBeUndefined();
			adapter.write.mockClear();
			restored.setEntry('d.md', entry('d'));
			await restored.save();
			expect(adapter.write.mock.calls.some(([path]) => path === main)).toBe(true);
			expect((await reload()).getAllPaths().sort()).toEqual(['a.md', 'b.md', 'd.md']);
		});

		it('compacts after a partial append instead of joining the next record to its torn bytes', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			manifest.setEntry('a.md', entry('a'));
			await manifest.save();
			manifest.setEntry('b.md', entry('b'));
			await manifest.save();
			adapter.append.mockImplementationOnce(async (path, data) => {
				disk.set(path, (disk.get(path) ?? '') + data.slice(0, 10));
				throw new Error('ENOSPC');
			});
			manifest.setEntry('c.md', entry('c'));
			await expect(manifest.save()).rejects.toThrow('ENOSPC');
			manifest.setEntry('d.md', entry('d'));
			await manifest.save();
			const restored = await reload();
			expect(restored.getAllPaths().sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
			restored.setEntry('e.md', entry('e'));
			await restored.save();
			expect((await reload()).getAllPaths().sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
		});

		it('ignores a log left from before a completed compaction', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			manifest.setEntry('a.md', entry('a'));
			await manifest.save();
			manifest.setEntry('b.md', entry('b'));
			await manifest.save();
			const stale = disk.get(log)!;
			// A crash after a compaction's checkpoint write but before its next record.
			manifest.replaceManifest({ version: 1, files: { 'c.md': entry('c') } });
			await manifest.save();
			disk.set(log, stale);
			expect((await reload()).getAllPaths()).toEqual(['c.md']);
		});

		it('rejects a damaged record before the end of the log', async () => {
			const disk = new Map<string, string>();
			diskAdapter(disk);
			manifest.setEntry('a.md', entry('a'));
			await manifest.save();
			manifest.setEntry('b.md', entry('b'));
			await manifest.save();
			const [header, record] = disk.get(log)!.split('\n');
			disk.set(log, `${header}\n{"broken"\n${record}\n`);
			await expect(reload()).rejects.toThrow('Invalid manifest change log');
		});
	});
});
