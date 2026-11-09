import { TFile, TFolder, type FileManager, type MetadataCache, type TAbstractFile, type Vault } from 'obsidian';
import { portablePathKey } from '@/protocol/portable-path';
import { isCurrentVaultFile } from '@/sync/local/vault-file-identity';
import { processVaultMarkdown, readVaultMarkdown } from '@/reminders/data/vault-markdown';
import { MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import type { ReadingFile, ReadingVault } from './library';

/** The library lists the note as an issue instead of rewriting replaced bytes. */
const strictUtf8 = (error: unknown): never => {
	throw error instanceof MarkdownEncodingError ? new Error('Save this note as UTF-8 without null characters to use it in Reading. The original vault file remains synced.') : error;
};

/** Bind Reading snapshots to Obsidian file identities, even across equal-mtime edits. */
export function createObsidianReadingVault(vault: Vault, folder: string, options: {
	signal: AbortSignal;
	allowed: (path: string) => boolean;
	validate: () => void;
	fileManager: Pick<FileManager, 'renameFile'>;
	/** Obsidian's frontmatter cache, which lets Reading list notes without reading them. */
	metadataCache?: Pick<MetadataCache, 'getFileCache'>;
}): Pick<ReadingVault, 'files' | 'occupied' | 'read' | 'process' | 'create' | 'rename'> & Required<Pick<ReadingVault, 'file' | 'cachedProperties'>> & { changed(path: string): void } {
	const { signal, allowed, validate, fileManager, metadataCache } = options;
	const fileRefs = new WeakMap<ReadingFile, TFile>();
	const fileIds = new WeakMap<TFile, number>();
	const fileEvents = new WeakMap<TFile, number>();
	let nextFileId = 0;
	const resolve = (file: ReadingFile): TFile => {
		signal.throwIfAborted();
		const ref = fileRefs.get(file);
		if (!ref || !isCurrentVaultFile(vault, file.path, ref) || !allowed(file.path)) throw new Error('Reading note moved, was deleted, or is excluded from sync.');
		return ref;
	};
	const readingFile = (entry: TFile): ReadingFile => {
		if (!fileIds.has(entry)) fileIds.set(entry, ++nextFileId);
		const file = { path: entry.path, size: entry.stat.size, modifiedAt: entry.stat.mtime, revision: `${fileIds.get(entry)}:${entry.stat.mtime}:${entry.stat.size}:${fileEvents.get(entry) ?? 0}` };
		fileRefs.set(file, entry);
		return file;
	};
	return {
		files: () => {
			signal.throwIfAborted();
			validate();
			const result: ReadingFile[] = [];
			const walk = (entry: TAbstractFile) => {
				if (!allowed(entry.path)) return;
				if (entry instanceof TFolder) for (const child of entry.children) walk(child);
				else if (entry instanceof TFile && entry.extension.toLowerCase() === 'md') result.push(readingFile(entry));
			};
			const root = vault.getAbstractFileByPath(folder);
			if (root) walk(root);
			return result;
		},
		file: path => {
			signal.throwIfAborted();
			validate();
			const entry = vault.getAbstractFileByPath(path);
			// The same checks as a listing: inside the folder, allowed at every level, Markdown.
			if (!(entry instanceof TFile) || entry.extension.toLowerCase() !== 'md' || !path.startsWith(`${folder}/`)) return null;
			for (let parent = path; parent.includes('/'); parent = parent.slice(0, parent.lastIndexOf('/'))) if (!allowed(parent)) return null;
			return allowed(folder) ? readingFile(entry) : null;
		},
		cachedProperties: file => {
			const ref = fileRefs.get(file);
			if (!ref || !metadataCache) return undefined;
			const cache = metadataCache.getFileCache(ref);
			// An indexed note without frontmatter has no properties to list.
			return cache ? cache.frontmatter ?? {} : undefined;
		},
		changed: path => {
			const file = vault.getAbstractFileByPath(path);
			if (file instanceof TFile) fileEvents.set(file, (fileEvents.get(file) ?? 0) + 1);
		},
		occupied: path => vault.getAllLoadedFiles().some(file => portablePathKey(file.path) === portablePathKey(path)),
		read: async file => { const content = await readVaultMarkdown(vault, resolve(file)).catch(strictUtf8); resolve(file); return content; },
		process: (file, update) => processVaultMarkdown(vault, resolve(file), current => { resolve(file); return update(current); }).catch(strictUtf8),
		create: async (path, content) => {
			const segments = folder.split('/');
			for (let i = 1; i <= segments.length; i++) {
				signal.throwIfAborted();
				const part = segments.slice(0, i).join('/');
				if (!vault.getAbstractFileByPath(part)) {
					try { await vault.createFolder(part); } catch (error) { if (!(vault.getAbstractFileByPath(part) instanceof TFolder)) throw error; }
				}
			}
			signal.throwIfAborted();
			if (!allowed(path)) throw new Error('Reading folder is excluded from sync.');
			await vault.create(path, content);
		},
		rename: async (file, path) => {
			const ref = resolve(file);
			if (!allowed(path)) throw new Error('Reading folder is excluded from sync.');
			await fileManager.renameFile(ref, path);
		},
	};
}
