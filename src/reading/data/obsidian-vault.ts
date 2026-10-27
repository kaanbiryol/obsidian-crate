import { TFile, TFolder, type FileManager, type TAbstractFile, type Vault } from 'obsidian';
import { portablePathKey } from '@/protocol/portable-path';
import { isCurrentVaultFile } from '@/sync/local/vault-file-identity';
import { processVaultMarkdown, readVaultMarkdown } from '@/sync/local/vault-markdown';
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
}): Pick<ReadingVault, 'files' | 'occupied' | 'read' | 'process' | 'create' | 'rename'> & { changed(path: string): void } {
	const { signal, allowed, validate, fileManager } = options;
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
	return {
		files: () => {
			signal.throwIfAborted();
			validate();
			const result: ReadingFile[] = [];
			const walk = (entry: TAbstractFile) => {
				if (!allowed(entry.path)) return;
				if (entry instanceof TFolder) for (const child of entry.children) walk(child);
				else if (entry instanceof TFile && entry.extension.toLowerCase() === 'md') {
					if (!fileIds.has(entry)) fileIds.set(entry, ++nextFileId);
					const file = { path: entry.path, size: entry.stat.size, modifiedAt: entry.stat.mtime, revision: `${fileIds.get(entry)}:${entry.stat.mtime}:${entry.stat.size}:${fileEvents.get(entry) ?? 0}` };
					fileRefs.set(file, entry); result.push(file);
				}
			};
			const root = vault.getAbstractFileByPath(folder);
			if (root) walk(root);
			return result;
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
