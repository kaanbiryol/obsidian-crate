import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { LocalManifest } from './manifest';

function createMockAdapter() {
	return {
		exists: vi.fn().mockResolvedValue(false),
		read: vi.fn(),
		write: vi.fn().mockResolvedValue(undefined),
	};
}

function createLocalManifest(adapter: ReturnType<typeof createMockAdapter>): LocalManifest {
	const app = {
		vault: { adapter },
	} as unknown as App;

	const pluginManifest = {
		dir: '.obsidian/plugins/obsidian-crate',
	} as PluginManifest;

	return new LocalManifest(app, pluginManifest);
}

describe('LocalManifest', () => {
	let adapter: ReturnType<typeof createMockAdapter>;
	let manifest: LocalManifest;

	beforeEach(() => {
		adapter = createMockAdapter();
		manifest = createLocalManifest(adapter);
	});

	it('loads persisted manifest data when file exists', async () => {
		adapter.exists.mockResolvedValue(true);
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
		adapter.exists.mockResolvedValue(true);
		adapter.read.mockResolvedValue(JSON.stringify({ invalid: true }));

		await manifest.load();

		expect(manifest.getManifest()).toEqual({ version: 1, files: {} });
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

		expect(adapter.write).toHaveBeenCalledTimes(1);
		expect(adapter.write).toHaveBeenCalledWith(
			'.obsidian/plugins/obsidian-crate/file-manifest.json',
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

		const writes = adapter.write.mock.calls;
		const lastPayload = writes[writes.length - 1]?.[1];
		expect(JSON.parse(lastPayload as string)).toEqual({
			version: 1,
			files: {},
		});
	});
});
