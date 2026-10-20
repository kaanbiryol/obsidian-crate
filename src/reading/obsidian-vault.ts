import { TFile, TFolder, type TAbstractFile, type Vault } from 'obsidian';
import { portablePathKey } from '@/protocol/portable-path';
import { isCurrentVaultFile } from '@/sync/local/vault-file-identity';
import type { ReadingFile, ReadingVault } from './data/library';

/** Bind Reading snapshots to Obsidian file identities, even across equal-mtime edits. */
export function createObsidianReadingVault(vault: Vault, folder: string, options: {
	signal: AbortSignal;
	allowed: (path: string) => boolean;
	validate: () => void;
}): Pick<ReadingVault, 'files' | 'occupied' | 'read' | 'process' | 'create'> & { changed(path: string): void } {
	const { signal, allowed, validate } = options;
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
		read: async file => { const content = await vault.read(resolve(file)); resolve(file); return content; },
		process: (file, update) => vault.process(resolve(file), current => { resolve(file); return update(current); }),
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
	};
}
