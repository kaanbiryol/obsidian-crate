import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { LocalManifest } from './manifest';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/obsidian-crate`;

type MockAdapter = {
	exists: ReturnType<typeof vi.fn<(path: string) => Promise<boolean>>>;
	read: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
	write: ReturnType<typeof vi.fn<(path: string, data: string) => Promise<void>>>;
	remove: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
};

function createMockAdapter(): MockAdapter {
	return {
		exists: vi.fn().mockResolvedValue(false),
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

	it('loads persisted manifest data when file exists', async () => {
		adapter.exists.mockImplementation((path: string) =>
			Promise.resolve(path.endsWith('file-manifest.json') && !path.endsWith('.tmp')),
		);
		adapter.read.mockResolvedValue(
			JSON.stringify({
				version: 1,
				lastSeq: 12,
				files: {
					'note.md': {
						hash: 'abc',
						size: 10,
						modified: '2026-02-06T12:00:00.000Z',
					},
				},
			}),
		);

		await manifest.load();

		expect(manifest.getEntry('note.md')).toEqual({
			hash: 'abc',
			size: 10,
			modified: '2026-02-06T12:00:00.000Z',
		});
		expect(manifest.getManifest().lastSeq).toBe(12);
	});

	it('ignores malformed persisted shape and keeps defaults', async () => {
		adapter.exists.mockImplementation((path: string) =>
			Promise.resolve(path.endsWith('file-manifest.json') && !path.endsWith('.tmp')),
		);
		adapter.read.mockResolvedValue(JSON.stringify({ invalid: true }));

		await manifest.load();

		expect(manifest.getManifest()).toEqual({ version: 1, files: {} });
	});

	it('drops malformed persisted file entries instead of trusting them', async () => {
		adapter.exists.mockImplementation((path: string) =>
			Promise.resolve(path.endsWith('file-manifest.json') && !path.endsWith('.tmp')),
		);
		adapter.read.mockResolvedValue(JSON.stringify({
			version: 1,
			lastSeq: 42,
			files: {
				'good.md': {
					hash: 'hash-1',
					size: 12,
					modified: '2026-02-06T12:00:00.000Z',
				},
				'bad-size.md': {
					hash: 'hash-2',
					size: -1,
					modified: '2026-02-06T12:00:00.000Z',
				},
				'bad-modified.md': {
					hash: 'hash-3',
					size: 4,
					modified: 123,
				},
			},
		}));

		await manifest.load();

		expect(manifest.getManifest()).toEqual({
			version: 1,
			lastSeq: 42,
			files: {
				'good.md': {
					hash: 'hash-1',
					size: 12,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
		});
	});

	it('recovers from tmp file when main file is corrupt', async () => {
		const validManifest = JSON.stringify({
			version: 1,
			files: { 'a.md': { hash: 'h', size: 5, modified: '2026-01-01T00:00:00.000Z' } },
		});
		adapter.exists.mockImplementation((path: string) => Promise.resolve(true));
		adapter.read.mockImplementation((path: string) => {
			if (path.endsWith('.tmp')) return Promise.resolve(validManifest);
			return Promise.resolve('{corrupt');
		});

		await manifest.load();

		expect(manifest.getEntry('a.md')).toEqual({ hash: 'h', size: 5, modified: '2026-01-01T00:00:00.000Z' });
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
			hash: 'hash-1',
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
			hash: 'hash-1',
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
			version: 1,
			files: {},
		});
	});

	it('normalizes replacement manifests before storing them', () => {
		manifest.replaceManifest({
			version: 1,
			files: {
				'ok.md': {
					hash: 'hash-1',
					size: 10,
					modified: '2026-02-06T12:00:00.000Z',
				},
				'bad.md': {
					hash: '',
					size: -1,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
			lastSeq: -5,
		} as never);

		expect(manifest.getManifest()).toEqual({
			version: 1,
			files: {
				'ok.md': {
					hash: 'hash-1',
					size: 10,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
		});
	});
});
