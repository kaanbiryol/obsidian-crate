import type { DataAdapter } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { computeHash } from './hasher';
import { assertLocalSyncPath } from './local-path-safety';

interface PendingVerificationContext {
	adapter: Pick<DataAdapter, 'stat' | 'readBinary'>;
	manifest: {
		getEntry(path: string): FileEntry | undefined;
		setEntry(path: string, entry: FileEntry): void;
		save(): Promise<void>;
	};
	isCurrent: (key: string) => boolean;
}

/** Settle local file events by content, without contacting the server. */
export async function verifyUnchangedPendingPaths(context: PendingVerificationContext, keys: string[]): Promise<string[]> {
	const { adapter, manifest, isCurrent } = context;
	const matches: Array<{ key: string; baseline: FileEntry; modified: string }> = [];
	// Read sequentially to keep memory bounded even for large attachments.
	for (const key of keys) {
		if (key.startsWith('delete:') || !isCurrent(key)) continue;
		const baseline = manifest.getEntry(key);
		if (!baseline) continue;
		try {
			assertLocalSyncPath(key);
			const before = await adapter.stat(key);
			if (!before || before.type !== 'file' || before.size > MAX_FILE_SIZE_BYTES || !isCurrent(key)) continue;
			const bytes = await adapter.readBinary(key);
			if (bytes.byteLength > MAX_FILE_SIZE_BYTES || !isCurrent(key)) continue;
			const hash = await computeHash(bytes);
			if (hash !== baseline.hash || !isCurrent(key)) continue;
			const after = await adapter.stat(key);
			if (!after || after.type !== 'file' || after.mtime !== before.mtime
				|| after.size !== before.size || after.size !== bytes.byteLength) continue;
			matches.push({ key, baseline, modified: new Date(before.mtime).toISOString() });
		} catch {
			// Unreadable or changing files stay pending for ordinary sync/review.
		}
	}
	const settled: string[] = [];
	let updated = false;
	for (const { key, baseline, modified } of matches) {
		if (!isCurrent(key) || manifest.getEntry(key) !== baseline) continue;
		if (baseline.modified !== modified) {
			manifest.setEntry(key, { ...baseline, modified });
			updated = true;
		}
		settled.push(key);
	}
	if (updated) await manifest.save();
	return settled.filter(isCurrent);
}
