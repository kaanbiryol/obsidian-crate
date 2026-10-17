import { withSyncFileContext } from './issues';
import type { DataAdapter, Vault } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { UNVERIFIED_MODIFIED } from './applied-content';
import type { VaultFile } from './file-discovery';
import { computeHash } from './hasher';

export const VERIFICATION_FILE_BUDGET = 32;
export const VERIFICATION_BYTE_BUDGET = 8 * 1024 * 1024;

interface VerificationManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	setEntry(path: string, entry: FileEntry): void;
	save(): Promise<void>;
}

/** Rotating content checks complement filesystem events and metadata hints. */
export class LocalContentVerifier {
	private cursor = '';
	private checks: Promise<unknown> = Promise.resolve();
	private loaded = false;

	constructor(private readonly progress?: { adapter: Pick<DataAdapter, 'read' | 'write' | 'exists'>; path: string; authority: string }) {}

	private async loadProgress(): Promise<void> {
		if (this.loaded || !this.progress) return;
		const { adapter, path, authority } = this.progress;
		if (await adapter.exists(path)) {
			// A damaged or foreign cursor is a disposable scheduling hint. I/O
			// failures remain visible instead of silently restarting every check.
			const raw = await adapter.read(path);
			try {
				const saved = JSON.parse(raw) as { version?: unknown; authority?: unknown; cursor?: unknown };
				if (saved.version === 1 && saved.authority === authority && typeof saved.cursor === 'string') this.cursor = saved.cursor;
			} catch { /* Restart the rotation; no sync authority is changed. */ }
		}
		this.loaded = true;
	}

	verify(vault: Vault, manifest: VerificationManifest, files: VaultFile[], signal: AbortSignal): Promise<boolean> {
		const task = this.checks.then(() => this.check(vault, manifest, files, signal));
		this.checks = task.catch(() => {});
		return task;
	}

	private async check(vault: Vault, manifest: VerificationManifest, files: VaultFile[], signal: AbortSignal): Promise<boolean> {
		signal.throwIfAborted();
		await this.loadProgress();
		// The next files in path order after the cursor, wrapping to the start,
		// selected without sorting the whole vault on every check.
		const eligible = (file: VaultFile) => file.size <= MAX_FILE_SIZE_BYTES;
		const cursor = this.cursor;
		const after = smallestByPath(files, VERIFICATION_FILE_BUDGET, file => eligible(file) && file.path > cursor);
		const rotation = [...after, ...smallestByPath(files, VERIFICATION_FILE_BUDGET - after.length, file => eligible(file) && file.path <= cursor)];
		let bytes = 0;
		let changed = false;
		try {
			for (let count = 0; count < rotation.length; count++) {
				signal.throwIfAborted();
				const file = rotation[count]!;
				// One larger eligible file may exceed the byte budget; it must not starve.
				if (count > 0 && bytes + file.size > VERIFICATION_BYTE_BUDGET) break;
				this.cursor = file.path;
				bytes += file.size;
				const entry = manifest.getEntry(file.path);
				if (!entry || Date.parse(entry.modified) !== file.mtime || entry.size !== file.size) continue;
				const content = await withSyncFileContext(file.path, () => vault.adapter.readBinary(file.path));
				const hash = await computeHash(content);
				signal.throwIfAborted();
				if (manifest.getEntry(file.path) !== entry) continue;
				if (hash !== entry.hash) {
					// Preserve the common ancestor and revision. Invalidate only the
					// metadata shortcut so the planner (and a restarted client) re-reads.
					manifest.setEntry(file.path, { ...entry, modified: UNVERIFIED_MODIFIED });
					changed = true;
				}
			}
		} finally {
			if (changed) await manifest.save();
			if (this.progress && !signal.aborted) {
				const { adapter, path, authority } = this.progress;
				await adapter.write(path, JSON.stringify({ version: 1, authority, cursor: this.cursor }));
			}
		}
		return changed;
	}
}

/** Up to `limit` matching files in ascending path order, in one pass. */
function smallestByPath(files: VaultFile[], limit: number, include: (file: VaultFile) => boolean): VaultFile[] {
	const selected: VaultFile[] = [];
	if (limit <= 0) return selected;
	for (const file of files) {
		if (!include(file)) continue;
		if (selected.length === limit && file.path >= selected[limit - 1]!.path) continue;
		let index = selected.length;
		while (index > 0 && selected[index - 1]!.path > file.path) index--;
		selected.splice(index, 0, file);
		if (selected.length > limit) selected.pop();
	}
	return selected;
}
