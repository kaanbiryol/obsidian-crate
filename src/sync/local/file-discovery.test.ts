import { describe, expect, it, vi } from 'vitest';
import type { TFile, Vault } from 'obsidian';
import { shouldIgnoreSyncPath } from './ignore';
import {
	getAllVaultFiles,
	getExtensionFromPath,
	insertBeforeExtension,
	isHiddenPath,
} from './file-discovery';

describe('file-discovery helpers', () => {
	it('detects hidden paths by dot-prefixed segments', () => {
		expect(isHiddenPath('.gitignore')).toBe(true);
		expect(isHiddenPath('notes/.trash/file.md')).toBe(true);
		expect(isHiddenPath('notes/file.md')).toBe(false);
	});

	it('extracts extensions correctly from edge-case paths', () => {
		expect(getExtensionFromPath('.gitignore')).toBe('');
		expect(getExtensionFromPath('notes/archive.tar.gz')).toBe('gz');
		expect(getExtensionFromPath('notes/README')).toBe('');
	});

	it('inserts text before the extension with the same rule', () => {
		expect(insertBeforeExtension('.env', ' (copy)')).toBe('.env (copy)');
		expect(insertBeforeExtension('notes/.env', ' (copy)')).toBe('notes/.env (copy)');
		expect(insertBeforeExtension('notes/archive.tar.gz', ' (copy)')).toBe('notes/archive.tar (copy).gz');
		expect(insertBeforeExtension('v1.2/README', ' (copy)')).toBe('v1.2/README (copy)');
		expect(insertBeforeExtension('.obsidian/app.json', ' (copy)')).toBe('.obsidian/app (copy).json');
	});
});

describe('getAllVaultFiles', () => {
	it('lists only the root and hidden root folders, never visible folders', async () => {
		const tree: Record<string, { files: string[]; folders: string[] }> = {
			'': { files: ['.gitignore'], folders: ['.cfg', 'A'] },
			'.cfg': { files: ['.cfg/a.json'], folders: ['.cfg/.inner'] },
			'.cfg/.inner': { files: ['.cfg/.inner/b.json'], folders: [] },
		};
		const list = vi.fn(async (path: string) => tree[path] ?? Promise.reject(new Error(`Unexpected directory scan: ${path}`)));
		const vault = { getFiles: () => [], adapter: { list, stat: vi.fn(async () => ({ type: 'file', size: 1, mtime: 1 })) } } as unknown as Vault;

		const files = await getAllVaultFiles(vault, () => false);

		// Before: every visible folder was listed to find hidden folders below it.
		expect(files.map(file => file.path)).toEqual(['.cfg/a.json', '.cfg/.inner/b.json', '.gitignore']);
		expect(list.mock.calls.map(call => call[0]).sort()).toEqual(['', '.cfg', '.cfg/.inner']);
	});

	it('stats hidden files with bounded overlap and keeps listing order', async () => {
		const hidden = Array.from({ length: 30 }, (_, index) => `.cfg/${String(index).padStart(2, '0')}.json`);
		let active = 0, peak = 0;
		const stat = vi.fn(async () => {
			active++; peak = Math.max(peak, active);
			await new Promise(resolve => setTimeout(resolve, 1));
			active--;
			return { type: 'file', size: 1, mtime: 1 };
		});
		const vault = {
			getFiles: vi.fn(() => []),
			adapter: { list: vi.fn(async (path: string) => path === '' ? { files: [], folders: ['.cfg'] } : { files: hidden, folders: [] }), stat },
		} as unknown as Vault;
		const files = await getAllVaultFiles(vault, () => false);
		// Before: one stat at a time.
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(8);
		expect(files.map(file => file.path)).toEqual(hidden);
	});

	it('skips a root Git repository before listing its contents', async () => {
		const listings: Record<string, { files: string[]; folders: string[] }> = {
			'': { files: ['.gitignore'], folders: ['.git', 'Projects'] },
		};
		const list = vi.fn(async (path: string) => {
			if (!listings[path]) throw new Error(`Unexpected directory scan: ${path}`);
			return listings[path];
		});
		const vault = {
			getFiles: vi.fn(() => []),
			adapter: { list, stat: vi.fn(async () => ({ type: 'file', size: 10, mtime: 1 })) },
		} as unknown as Vault;
		const context = { ignoredDirPrefixes: ['.git/'], ignorePatterns: ['.git/'], patternCache: new Map<string, RegExp>() };

		const files = await getAllVaultFiles(vault, path => shouldIgnoreSyncPath(path, context));

		expect(files.map(file => file.path)).toEqual(['.gitignore']);
		expect(list).not.toHaveBeenCalledWith('.git');
	});

	it('merges indexed files with hidden files and avoids duplicates', async () => {
		const indexedFiles = [
			{
				path: 'notes/a.md',
				stat: { size: 100, mtime: 11 },
				extension: 'md',
			},
			{
				path: '.config-hidden/config.json',
				stat: { size: 200, mtime: 12 },
				extension: 'json',
			},
		] as unknown as TFile[];

		const list = vi.fn(async (folderPath: string) => {
			if (folderPath === '') {
				return {
					files: ['.gitignore', 'notes/a.md'],
					folders: ['.config-hidden', 'notes'],
				};
			}
			if (folderPath === '.config-hidden') {
				return {
					files: ['.config-hidden/config.json'],
					folders: ['.config-hidden/plugins'],
				};
			}
			if (folderPath === '.config-hidden/plugins') {
				return {
					files: ['.config-hidden/plugins/cache.db'],
					folders: [],
				};
			}
			return { files: [], folders: [] };
		});

		const stat = vi.fn(async (path: string) => {
			if (path === '.gitignore') {
				return { type: 'file', size: 15, mtime: 1000 };
			}
			if (path === '.config-hidden/config.json') {
				return { type: 'file', size: 200, mtime: 12 };
			}
			if (path === '.config-hidden/plugins/cache.db') {
				return { type: 'file', size: 300, mtime: 13 };
			}
			return null;
		});

		const vault = {
			getFiles: vi.fn(() => indexedFiles),
			adapter: { list, stat },
		} as unknown as Vault;

		const files = await getAllVaultFiles(
			vault,
			path => path === '.config-hidden/plugins' || path === '.config-hidden/plugins/',
		);

		expect(files.map(f => f.path)).toEqual([
			'notes/a.md',
			'.config-hidden/config.json',
			'.gitignore',
		]);
		expect(files.filter(f => f.path === '.config-hidden/config.json')).toHaveLength(1);
		expect(files.find(f => f.path === '.gitignore')?.extension).toBe('');
		expect(stat).not.toHaveBeenCalledWith('.config-hidden/plugins/cache.db');
	});

	it('rejects an incomplete scan when adapter listing the root fails', async () => {
		const indexedFiles = [
			{
				path: 'notes/a.md',
				stat: { size: 100, mtime: 11 },
				extension: 'md',
			},
		] as unknown as TFile[];

		const vault = {
			getFiles: vi.fn(() => indexedFiles),
			adapter: {
				list: vi.fn(async () => {
					throw new Error('adapter down');
				}),
				stat: vi.fn(),
			},
		} as unknown as Vault;

		await expect(getAllVaultFiles(vault, () => false)).rejects.toThrow('Vault scan incomplete: cannot list /: adapter down');
	});

	it('rejects an incomplete scan when a hidden file stat fails', async () => {
		const list = vi.fn(async (folderPath: string) => {
			if (folderPath === '') {
				return {
					files: ['.gitignore'],
					folders: ['.config-hidden'],
				};
			}
			if (folderPath === '.config-hidden') {
				return {
					files: ['.config-hidden/config.json'],
					folders: [],
				};
			}
			return { files: [], folders: [] };
		});

		const stat = vi.fn(async (path: string) => {
			if (path === '.gitignore') {
				return { type: 'file', size: 15, mtime: 1000 };
			}
			if (path === '.config-hidden/config.json') {
				throw new Error('permission denied');
			}
			return null;
		});

		const vault = {
			getFiles: vi.fn(() => []),
			adapter: { list, stat },
		} as unknown as Vault;

		const scan = getAllVaultFiles(vault, () => false);
		await expect(scan).rejects.toThrow('Vault scan incomplete: cannot stat .config-hidden/config.json: permission denied');
		await expect(scan).rejects.toMatchObject({ issues: [{ path: '.config-hidden/config.json', code: 'vault-scan-incomplete' }] });
	});
});
