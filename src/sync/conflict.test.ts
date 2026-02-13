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

describe('detectConflicts (3-way hash)', () => {
	it('skips files with matching hashes', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('same', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('same', '2026-02-06T12:01:00.000Z') },
			{},
		);

		expect(diffs).toHaveLength(0);
	});

	it('returns conflict when both sides changed since manifest', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('local-v2', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('remote-v2', '2026-02-06T12:01:00.000Z') },
			{ 'note.md': entry('base-v1', '2026-02-06T10:00:00.000Z') },
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'conflict',
			localHash: 'local-v2',
			remoteHash: 'remote-v2',
		});
	});

	it('returns conflict when new file on both sides with different content', () => {
		const diffs = detectConflicts(
			{ 'new.md': entry('local', '2026-02-06T12:00:00.000Z') },
			{ 'new.md': entry('remote', '2026-02-06T12:01:00.000Z') },
			{}, // no manifest entry
		);

		expect(diffs).toContainEqual({
			path: 'new.md',
			action: 'conflict',
			localHash: 'local',
			remoteHash: 'remote',
		});
	});

	it('returns upload when only local changed since manifest', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('local-v2', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('base-v1', '2026-02-06T10:00:00.000Z') },
			{ 'note.md': entry('base-v1', '2026-02-06T10:00:00.000Z') },
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'upload',
			localHash: 'local-v2',
			remoteHash: 'base-v1',
		});
	});

	it('returns download when only remote changed since manifest', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('base-v1', '2026-02-06T10:00:00.000Z') },
			{ 'note.md': entry('remote-v2', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('base-v1', '2026-02-06T10:00:00.000Z') },
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'download',
			localHash: 'base-v1',
			remoteHash: 'remote-v2',
		});
	});

	it('returns download when local matches manifest but remote differs', () => {
		const diffs = detectConflicts(
			{ 'note.md': entry('base', '2026-02-06T10:00:00.000Z') },
			{ 'note.md': entry('remote', '2026-02-06T12:00:00.000Z') },
			{ 'note.md': entry('base', '2026-02-06T10:00:00.000Z') },
		);

		expect(diffs).toContainEqual({
			path: 'note.md',
			action: 'download',
			localHash: 'base',
			remoteHash: 'remote',
		});
	});

	it('returns upload for local-only files', () => {
		const diffs = detectConflicts(
			{ 'local.md': entry('abc', '2026-02-06T12:00:00.000Z') },
			{},
			{},
		);

		expect(diffs).toContainEqual({
			path: 'local.md',
			action: 'upload',
			localHash: 'abc',
		});
	});

	it('returns download for remote-only files', () => {
		const diffs = detectConflicts(
			{},
			{ 'remote.md': entry('xyz', '2026-02-06T12:00:00.000Z') },
			{},
		);

		expect(diffs).toContainEqual({
			path: 'remote.md',
			action: 'download',
			remoteHash: 'xyz',
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

		const name = getConflictFileName('notes/test.md');
		expect(name).toMatch(
			/^notes\/test \(conflict 2026-01-02 03-04-05 [a-z0-9]{4}\)\.md$/,
		);
	});

	it('generates timestamped conflict name for extensionless file', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		const name = getConflictFileName('README');
		expect(name).toMatch(
			/^README \(conflict 2026-01-02 03-04-05 [a-z0-9]{4}\)$/,
		);
	});

	it('generates unique names on consecutive calls', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		const a = getConflictFileName('notes/test.md');
		const b = getConflictFileName('notes/test.md');
		// Random suffix makes collision extremely unlikely
		expect(a).not.toBe(b);
	});

	it('recognizes new conflict file names', () => {
		expect(isConflictFile('notes/test (conflict 2026-01-02 03-04-05 a1b2).md')).toBe(
			true,
		);
		expect(isConflictFile('notes/test.md')).toBe(false);
	});

	it('recognizes old conflict file names (backward compat)', () => {
		expect(isConflictFile('notes/test (conflict 2026-01-02 03-04).md')).toBe(
			true,
		);
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

		expect(path).toMatch(/^\.obsidian\/config \(conflict 2026-01-02 03-04-05 [a-z0-9]{4}\)\.json$/);
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

		expect(path).toMatch(/^notes\/test \(conflict 2026-01-02 03-04-05 [a-z0-9]{4}\)\.md$/);
		expect(vault.createFolder).toHaveBeenCalledWith('notes');
		expect(vault.createBinary).toHaveBeenCalledWith(path, content);
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});
});
