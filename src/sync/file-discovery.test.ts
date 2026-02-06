import { describe, expect, it, vi } from 'vitest';
import type { TFile, Vault } from 'obsidian';
import {
	getAllVaultFiles,
	getExtensionFromPath,
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
});

describe('getAllVaultFiles', () => {
	it('merges indexed files with hidden files and avoids duplicates', async () => {
		const indexedFiles = [
			{
				path: 'notes/a.md',
				stat: { size: 100, mtime: 11 },
				extension: 'md',
			},
			{
				path: '.obsidian/config.json',
				stat: { size: 200, mtime: 12 },
				extension: 'json',
			},
		] as unknown as TFile[];

		const list = vi.fn(async (folderPath: string) => {
			if (folderPath === '') {
				return {
					files: ['.gitignore', 'notes/a.md'],
					folders: ['.obsidian', 'notes'],
				};
			}
			if (folderPath === '.obsidian') {
				return {
					files: ['.obsidian/config.json'],
					folders: ['.obsidian/plugins'],
				};
			}
			if (folderPath === '.obsidian/plugins') {
				return {
					files: ['.obsidian/plugins/cache.db'],
					folders: [],
				};
			}
			return { files: [], folders: [] };
		});

		const stat = vi.fn(async (path: string) => {
			if (path === '.gitignore') {
				return { type: 'file', size: 15, mtime: 1000 };
			}
			if (path === '.obsidian/config.json') {
				return { type: 'file', size: 200, mtime: 12 };
			}
			if (path === '.obsidian/plugins/cache.db') {
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
			path => path === '.obsidian/plugins' || path === '.obsidian/plugins/',
		);

		expect(files.map(f => f.path)).toEqual([
			'notes/a.md',
			'.obsidian/config.json',
			'.gitignore',
		]);
		expect(files.filter(f => f.path === '.obsidian/config.json')).toHaveLength(1);
		expect(files.find(f => f.path === '.gitignore')?.extension).toBe('');
		expect(stat).not.toHaveBeenCalledWith('.obsidian/plugins/cache.db');
	});

	it('discovers hidden folders nested under non-hidden paths', async () => {
		const indexedFiles = [
			{
				path: 'notes/a.md',
				stat: { size: 100, mtime: 11 },
				extension: 'md',
			},
		] as unknown as TFile[];

		const list = vi.fn(async (folderPath: string) => {
			if (folderPath === '') {
				return {
					files: [],
					folders: ['notes'],
				};
			}
			if (folderPath === 'notes') {
				return {
					files: ['notes/a.md'],
					folders: ['notes/.config'],
				};
			}
			if (folderPath === 'notes/.config') {
				return {
					files: ['notes/.config/local.json'],
					folders: [],
				};
			}
			return { files: [], folders: [] };
		});

		const stat = vi.fn(async (path: string) => {
			if (path === 'notes/.config/local.json') {
				return { type: 'file', size: 50, mtime: 44 };
			}
			return null;
		});

		const vault = {
			getFiles: vi.fn(() => indexedFiles),
			adapter: { list, stat },
		} as unknown as Vault;

		const files = await getAllVaultFiles(vault, () => false);
		expect(files.map(f => f.path)).toContain('notes/.config/local.json');
	});
});
