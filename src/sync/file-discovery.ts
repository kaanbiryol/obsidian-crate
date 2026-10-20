import { SyncIssueError } from './issues';
import { isAbortError } from './abort';
/**
 * File discovery — merges Obsidian-indexed files with hidden (dot) files
 * discovered via the low-level vault adapter.
 */

import type { Vault, TFile } from 'obsidian';
import { errorMessage } from './logger';
import { assertPortablePaths } from '../protocol/portable-path';

/**
 * Normalised file descriptor that works for both indexed and hidden files.
 */
export interface VaultFile {
	path: string;
	size: number;
	mtime: number;
	extension: string;
}

interface AdapterListing {
	files: string[];
	folders: string[];
}

/**
 * Check whether any segment in a path starts with a dot.
 */
export function isHiddenPath(path: string): boolean {
	return path.split('/').some(segment => segment.startsWith('.'));
}

/**
 * Extract the extension from a path string (without the leading dot).
 * Returns empty string for extensionless files like `.gitignore`.
 */
export function getExtensionFromPath(path: string): string {
	const basename = path.split('/').pop() ?? '';
	const dotIndex = basename.lastIndexOf('.');
	// No dot, or dot is the first character (e.g. `.gitignore`)
	if (dotIndex <= 0) return '';
	return basename.substring(dotIndex + 1);
}

/**
 * Convert a TFile to a VaultFile.
 */
export function tfileToVaultFile(file: TFile): VaultFile {
	return {
		path: file.path,
		size: file.stat.size,
		mtime: file.stat.mtime,
		extension: file.extension,
	};
}

/**
 * Discover all vault files — both Obsidian-indexed and hidden.
 *
 * Hidden files are discovered by recursing into dot-prefixed folders via
 * `vault.adapter.list()` + `vault.adapter.stat()`. Non-hidden folders are
 * walked to find hidden descendants. An incomplete scan rejects: callers must
 * never use a partial snapshot as evidence that an undiscovered file was deleted.
 *
 * @param shouldIgnore  Predicate used to skip ignored paths early (avoids
 *                      stat-ing thousands of files in e.g. `.git/`).
 * @param assertActive  Cancellation check before and after each filesystem read.
 */
export async function getAllVaultFiles(
	vault: Vault,
	shouldIgnore: (path: string) => boolean,
	assertActive?: () => void,
): Promise<VaultFile[]> {
	assertActive?.();
	// Start with all indexed files
	const indexedFiles = vault.getFiles();
	const result: VaultFile[] = indexedFiles
		.filter(f => !shouldIgnore(f.path))
		.map(tfileToVaultFile);

	// Collect paths already included so we don't duplicate
	const seen = new Set(result.map(f => f.path));

	// Discover hidden files by walking dot-prefixed entries at root
	const root = await safeList(vault, '', assertActive);

	// Recurse into hidden folders
	const hiddenFolders = root.folders.filter(f => {
		const name = f.split('/').pop() ?? '';
		return name.startsWith('.');
	});

	for (const folder of hiddenFolders) {
		if (shouldIgnore(folder) || shouldIgnore(folder + '/')) continue;
		await walkHiddenFolder(vault, folder, shouldIgnore, seen, result, assertActive);
	}

	// Discover hidden subfolders nested under non-hidden roots (e.g. notes/.config/)
	const visibleRootFolders = root.folders.filter(folder => {
		const name = folder.split('/').pop() ?? '';
		return !name.startsWith('.');
	});
	await walkForNestedHiddenFolders(vault, visibleRootFolders.filter(folder => !shouldIgnore(folder) && !shouldIgnore(folder + '/')),
		shouldIgnore, seen, result, assertActive);

	// Include hidden files at the root level (e.g. `.gitignore`)
	await addStatFiles(vault, root.files.filter(filePath => (filePath.split('/').pop() ?? '').startsWith('.')),
		shouldIgnore, seen, result, assertActive);

	assertActive?.();
	assertPortablePaths(result.map(file => file.path));
	return result;
}

/**
 * Recursively walk a hidden folder, adding files to `result`.
 */
async function walkHiddenFolder(
	vault: Vault,
	folderPath: string,
	shouldIgnore: (path: string) => boolean,
	seen: Set<string>,
	result: VaultFile[],
	assertActive?: () => void,
): Promise<void> {
	const pendingFolders = [folderPath];
	const visitedFolders = new Set<string>();
	while (pendingFolders.length > 0) {
		const currentFolder = pendingFolders.pop();
		if (!currentFolder || visitedFolders.has(currentFolder)) continue;
		visitedFolders.add(currentFolder);
		const listing = await safeList(vault, currentFolder, assertActive);
		await addStatFiles(vault, listing.files, shouldIgnore, seen, result, assertActive);

		for (const subfolder of listing.folders) {
			if (shouldIgnore(subfolder) || shouldIgnore(subfolder + '/')) continue;
			pendingFolders.push(subfolder);
		}
	}
}

// Folder listings and stats are slow bridge calls on mobile; a bounded pool overlaps them.
const LISTING_CONCURRENCY = 8;
const STAT_CONCURRENCY = 8;

/**
 * Stat candidate files with bounded concurrency and add them in listing order.
 */
async function addStatFiles(
	vault: Vault,
	filePaths: string[],
	shouldIgnore: (path: string) => boolean,
	seen: Set<string>,
	result: VaultFile[],
	assertActive?: () => void,
): Promise<void> {
	const candidates = [...new Set(filePaths)].filter(filePath => !seen.has(filePath) && !shouldIgnore(filePath));
	const stats = new Array<Awaited<ReturnType<typeof safeStat>>>(candidates.length);
	let next = 0;
	const worker = async () => {
		while (next < candidates.length) {
			const index = next++;
			stats[index] = await safeStat(vault, candidates[index]!, assertActive);
		}
	};
	await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, worker));
	candidates.forEach((filePath, index) => {
		const stat = stats[index];
		if (!stat || stat.type !== 'file') return;
		seen.add(filePath);
		result.push({
			path: filePath,
			size: stat.size,
			mtime: stat.mtime,
			extension: getExtensionFromPath(filePath),
		});
	});
}

/**
 * Walk non-hidden folders and recurse into hidden descendants only. Listings run
 * concurrently; hidden folders are then walked in path order, so results stay
 * deterministic.
 */
async function walkForNestedHiddenFolders(
	vault: Vault,
	folderPaths: string[],
	shouldIgnore: (path: string) => boolean,
	seen: Set<string>,
	result: VaultFile[],
	assertActive?: () => void,
): Promise<void> {
	const pendingFolders = [...folderPaths];
	const visitedFolders = new Set<string>();
	const hiddenFolders: string[] = [];
	const worker = async () => {
		while (pendingFolders.length > 0) {
			const currentFolder = pendingFolders.pop()!;
			if (visitedFolders.has(currentFolder)) continue;
			visitedFolders.add(currentFolder);
			const listing = await safeList(vault, currentFolder, assertActive);
			for (const subfolder of listing.folders) {
				if (shouldIgnore(subfolder) || shouldIgnore(subfolder + '/')) continue;
				const name = subfolder.split('/').pop() ?? '';
				if (name.startsWith('.')) hiddenFolders.push(subfolder);
				else pendingFolders.push(subfolder);
			}
		}
	};
	// Workers that find the queue empty exit; a worker that lists more folders
	// keeps draining them, so start new workers until the queue settles.
	while (pendingFolders.length > 0) {
		await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, pendingFolders.length) }, worker));
	}
	for (const folder of hiddenFolders.sort()) {
		await walkHiddenFolder(vault, folder, shouldIgnore, seen, result, assertActive);
	}
}

async function safeList(vault: Vault, folderPath: string, assertActive?: () => void): Promise<AdapterListing> {
	assertActive?.();
	let listing: AdapterListing;
	try {
		listing = await vault.adapter.list(folderPath);
	} catch (error) {
		assertActive?.();
		if (isAbortError(error)) throw error;
		const message = `Vault scan incomplete: cannot list ${folderPath || '/'}: ${errorMessage(error)}`;
		throw new SyncIssueError(message, [{ message, ...(folderPath ? { path: folderPath } : {}) }]);
	}
	assertActive?.();
	return listing;
}

async function safeStat(vault: Vault, filePath: string, assertActive?: () => void): Promise<{ type: string; size: number; mtime: number } | null> {
	assertActive?.();
	let stat: { type: string; size: number; mtime: number } | null;
	try {
		stat = await vault.adapter.stat(filePath);
	} catch (error) {
		assertActive?.();
		if (isAbortError(error)) throw error;
		const message = `Vault scan incomplete: cannot stat ${filePath}: ${errorMessage(error)}`;
		throw new SyncIssueError(message, [{ path: filePath, message }]);
	}
	assertActive?.();
	return stat;
}
