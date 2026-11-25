import { SyncIssueError } from '../issues';
import { isAbortError } from '../abort';
import { runConcurrentTasks } from '../concurrency';
/**
 * File discovery — merges Obsidian-indexed files with hidden (dot) files
 * discovered via the low-level vault adapter.
 */

import type { Vault, TFile } from 'obsidian';
import { errorMessage } from '../../platform/logger';
import { assertPortablePaths } from '../../protocol/portable-path';

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

/** Create a file's parent folder, through the adapter for hidden paths, if it is missing. */
export async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
	const folderPath = path.substring(0, path.lastIndexOf('/'));
	if (!folderPath) return;
	noteHiddenPathChange(vault, path);
	try {
		if (isHiddenPath(path)) await vault.adapter.mkdir(folderPath);
		else await vault.createFolder(folderPath);
	} catch {
		// Folder already exists.
	}
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

/** Inserts text before the extension, with the same rule as `getExtensionFromPath`:
 * `notes/.env` gets `notes/.env (copy)`, and `a.tar.gz` gets `a.tar (copy).gz`. */
export function insertBeforeExtension(path: string, text: string): string {
	const nameStart = path.lastIndexOf('/') + 1;
	const dot = path.lastIndexOf('.');
	const end = dot > nameStart ? dot : path.length;
	return `${path.slice(0, end)}${text}${path.slice(end)}`;
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

// Finding hidden folders below visible ones means listing every visible folder. Each full
// walk remembers what it found, so frequent scans can walk just those, like the hidden
// root folders, until a change may have added one or the memory is this old.
export const NESTED_HIDDEN_FOLDERS_MAX_AGE_MS = 30 * 60_000;
const nestedHiddenFolders = new WeakMap<Vault, { folders: string[]; at: number }>();

/** The next scan of this vault lists every visible folder again. */
export function forgetNestedHiddenFolders(vault: Vault): void {
	nestedHiddenFolders.delete(vault);
}

/** Forgets the remembered folders when `path` lies in a hidden folder below a visible one
 * that the last full walk did not find. */
export function noteHiddenPathChange(vault: Vault, path: string): void {
	const remembered = nestedHiddenFolders.get(vault);
	if (!remembered) return;
	const segments = path.split('/');
	const hidden = segments.findIndex(segment => segment.startsWith('.'));
	// Hidden root folders are always walked, and a hidden file in a visible folder is not synced.
	if (hidden <= 0 || hidden === segments.length - 1) return;
	if (!remembered.folders.includes(segments.slice(0, hidden + 1).join('/'))) forgetNestedHiddenFolders(vault);
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
 * @param reuseNestedHidden  Walk the hidden folders below visible ones that a recent full
 *                      walk found instead of listing every visible folder. Such a scan can
 *                      miss a new hidden folder for a while, so it must never be evidence
 *                      that a file is absent.
 */
export async function getAllVaultFiles(
	vault: Vault,
	shouldIgnore: (path: string) => boolean,
	assertActive?: () => void,
	reuseNestedHidden = false,
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
	const remembered = reuseNestedHidden ? nestedHiddenFolders.get(vault) : undefined;
	if (remembered && Date.now() - remembered.at < NESTED_HIDDEN_FOLDERS_MAX_AGE_MS) {
		for (const folder of remembered.folders) {
			if (shouldIgnore(folder) || shouldIgnore(folder + '/')) continue;
			// A removed folder's tracked files are found missing like any other deletion.
			if ((await safeStat(vault, folder, assertActive))?.type !== 'folder') continue;
			await walkHiddenFolder(vault, folder, shouldIgnore, seen, result, assertActive);
		}
	} else {
		const folders = await walkForNestedHiddenFolders(vault, visibleRootFolders.filter(folder => !shouldIgnore(folder) && !shouldIgnore(folder + '/')),
			shouldIgnore, seen, result, assertActive);
		nestedHiddenFolders.set(vault, { folders, at: Date.now() });
	}

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
	const stats = await runConcurrentTasks(candidates.map(filePath => () => safeStat(vault, filePath, assertActive)), STAT_CONCURRENCY);
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
 * deterministic. Returns the hidden folders it walked.
 */
async function walkForNestedHiddenFolders(
	vault: Vault,
	folderPaths: string[],
	shouldIgnore: (path: string) => boolean,
	seen: Set<string>,
	result: VaultFile[],
	assertActive?: () => void,
): Promise<string[]> {
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
	return hiddenFolders;
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
		throw new SyncIssueError(message, [{ message, code: 'vault-scan-incomplete', ...(folderPath ? { path: folderPath } : {}) }]);
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
		throw new SyncIssueError(message, [{ path: filePath, message, code: 'vault-scan-incomplete' }]);
	}
	assertActive?.();
	return stat;
}
