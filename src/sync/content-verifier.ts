import type { Vault } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { UNVERIFIED_MODIFIED } from './applied-content';
import type { VaultFile } from './file-discovery';
import { computeHash } from './hasher';

export const VERIFICATION_FILE_BUDGET = 32;
export const VERIFICATION_BYTE_BUDGET = 8 * 1024 * 1024;

interface VerificationManifest {
	getEntry(path: string): FileEntry | undefined;
	setEntry(path: string, entry: FileEntry): void;
	save(): Promise<void>;
}

/** Rotating content checks complement filesystem events and metadata hints. */
export class LocalContentVerifier {
	private cursor = '';
	private checks: Promise<unknown> = Promise.resolve();

	verify(vault: Vault, manifest: VerificationManifest, files: VaultFile[], signal: AbortSignal): Promise<boolean> {
		const task = this.checks.then(() => this.check(vault, manifest, files, signal));
		this.checks = task.catch(() => {});
		return task;
	}

	private async check(vault: Vault, manifest: VerificationManifest, files: VaultFile[], signal: AbortSignal): Promise<boolean> {
		const eligible = files.filter(file => file.size <= MAX_FILE_SIZE_BYTES)
			.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		let start = eligible.findIndex(file => file.path > this.cursor);
		if (start < 0) start = 0;
		let bytes = 0;
		let changed = false;
		try {
			for (let count = 0; count < Math.min(eligible.length, VERIFICATION_FILE_BUDGET); count++) {
				signal.throwIfAborted();
				const file = eligible[(start + count) % eligible.length]!;
				// One larger eligible file may exceed the byte budget; it must not starve.
				if (count > 0 && bytes + file.size > VERIFICATION_BYTE_BUDGET) break;
				this.cursor = file.path;
				bytes += file.size;
				const entry = manifest.getEntry(file.path);
				if (!entry || Date.parse(entry.modified) !== file.mtime || entry.size !== file.size) continue;
				const content = await vault.adapter.readBinary(file.path);
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
		}
		return changed;
	}
}
