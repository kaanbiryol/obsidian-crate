import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vault } from 'obsidian';
import {
	createConflictCopy,
	detectConflicts,
	getConflictFileName,
	isConflictFile,
} from './conflict';

function entry(hash: string, modified: string) {
	return {
		hash,
		size: 1,
		modified,
	};
}

describe('detectConflicts', () => {
	it('returns conflict when local and remote changed after last sync', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('local', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('remote', '2026-02-06T12:01:00.000Z') },
			'2026-02-06T11:00:00.000Z',
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'conflict',
			localHash: 'local',
			remoteHash: 'remote',
		});
	});

	it('returns upload when only local changed after last sync', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('local', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('remote', '2026-02-06T10:00:00.000Z') },
			'2026-02-06T11:00:00.000Z',
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'upload',
			localHash: 'local',
			remoteHash: 'remote',
		});
	});

	it('returns download when only remote changed after last sync', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('local', '2026-02-06T10:00:00.000Z') },
			{ 'note.md': entry('remote', '2026-02-06T12:00:00.000Z') },
			'2026-02-06T11:00:00.000Z',
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'download',
			localHash: 'local',
			remoteHash: 'remote',
		});
	});

});

describe('conflict naming helpers', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('generates timestamped conflict name preserving extension', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		expect(getConflictFileName('notes/test.md')).toBe(
			'notes/test (conflict 2026-01-02 03-04).md',
		);
	});

	it('generates timestamped conflict name for extensionless file', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		expect(getConflictFileName('README')).toBe(
			'README (conflict 2026-01-02 03-04)',
		);
	});

	it('recognizes conflict file names', () => {
		expect(isConflictFile('notes/test (conflict 2026-01-02 03-04).md')).toBe(
			true,
		);
		expect(isConflictFile('notes/test.md')).toBe(false);
	});
});

describe('createConflictCopy', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes hidden conflict copies through adapter', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		const content = new TextEncoder().encode('hidden').buffer;
		const vault = {
			adapter: {
				mkdir: vi.fn().mockResolvedValue(undefined),
				writeBinary: vi.fn().mockResolvedValue(undefined),
			},
			createFolder: vi.fn().mockResolvedValue(undefined),
			createBinary: vi.fn().mockResolvedValue(undefined),
		} as unknown as Vault;

		const path = await createConflictCopy(vault, '.obsidian/config.json', content);

		expect(path).toBe('.obsidian/config (conflict 2026-01-02 03-04).json');
		expect(vault.adapter.mkdir).toHaveBeenCalledWith('.obsidian');
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(path, content);
		expect(vault.createBinary).not.toHaveBeenCalled();
	});

	it('writes regular conflict copies through vault API', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		const content = new TextEncoder().encode('regular').buffer;
		const vault = {
			adapter: {
				mkdir: vi.fn().mockResolvedValue(undefined),
				writeBinary: vi.fn().mockResolvedValue(undefined),
			},
			createFolder: vi.fn().mockResolvedValue(undefined),
			createBinary: vi.fn().mockResolvedValue(undefined),
		} as unknown as Vault;

		const path = await createConflictCopy(vault, 'notes/test.md', content);

		expect(path).toBe('notes/test (conflict 2026-01-02 03-04).md');
		expect(vault.createFolder).toHaveBeenCalledWith('notes');
		expect(vault.createBinary).toHaveBeenCalledWith(path, content);
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});
});
