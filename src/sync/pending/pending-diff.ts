import type { Vault } from 'obsidian';
import type { FileEntry } from '../../protocol/sync-types';
import { assertLocalSyncPath } from '../local/local-path-safety';
import { decodePreviewText, isBinaryPreviewPath } from '../history/preview-format';
import { MAX_PREVIEW_BYTES } from '../../protocol/sync-limits';
import { sha256Hex } from '../../platform/sha256';
import { localPathExists } from '../local/stored-name';

export interface PendingDiff {
	before?: string;
	after?: string;
	beforeSize: number;
	afterSize: number;
	kind: 'added' | 'modified' | 'deleted';
	unavailable?: string;
	unchanged?: boolean;
	baselineUnavailable?: boolean;
}

/** Read a snapshot for display only; never advance the manifest or sync queue. */
export async function loadPendingDiff(
	vault: Vault,
	baseline: Readonly<FileEntry> | undefined,
	readBase: (path: string, hash: string) => Promise<ArrayBuffer | null>,
	path: string,
	deleted: boolean,
): Promise<PendingDiff> {
	assertLocalSyncPath(path);
	const stat = await vault.adapter.stat(path);
	// After `todo.md` -> `TODO.md` on a case-insensitive file system, stat also finds the deleted old name.
	const local = deleted && stat && !await localPathExists(vault, path) ? null : stat;
	if (deleted ? local !== null : local?.type !== 'file') {
		throw new Error('This file changed. Refresh sync activity to see its latest state.');
	}
	const result: PendingDiff = {
		beforeSize: baseline?.size ?? 0,
		afterSize: local?.size ?? 0,
		kind: deleted ? 'deleted' : baseline ? 'modified' : 'added',
	};
	if (isBinaryPreviewPath(path)) {
		return { ...result, unavailable: 'A text preview isn’t available for this file. Open it to review its contents.' };
	}
	if (Math.max(result.beforeSize, result.afterSize) > MAX_PREVIEW_BYTES) {
		return { ...result, unavailable: 'This file is too large to preview (limit: 256 KB).' };
	}
	const afterBytes = deleted ? new ArrayBuffer(0) : await vault.adapter.readBinary(path);
	if (afterBytes.byteLength > MAX_PREVIEW_BYTES) {
		return { ...result, afterSize: afterBytes.byteLength, unavailable: 'This file is too large to preview (limit: 256 KB).' };
	}
	// A matching last-synced hash needs no cached contents, including for config files.
	const unchanged = !deleted && !!baseline && await sha256Hex(afterBytes) === baseline.hash;
	let beforeBytes = new ArrayBuffer(0);
	if (unchanged) {
		beforeBytes = afterBytes;
		result.unchanged = true;
	} else if (baseline) {
		const before = await readBase(path, baseline.hash);
		if (!before) {
			return { ...result, baselineUnavailable: true, unavailable: 'The last-synced copy isn’t available on this device. Line changes can’t be shown.' };
		}
		beforeBytes = before;
	} else if (deleted) {
		return { ...result, baselineUnavailable: true, unavailable: 'The last-synced copy isn’t available on this device. Line changes can’t be shown.' };
	}
	result.beforeSize = beforeBytes.byteLength;
	result.afterSize = afterBytes.byteLength;
	if (Math.max(result.beforeSize, result.afterSize) > MAX_PREVIEW_BYTES) {
		return { ...result, unavailable: 'This file is too large to preview (limit: 256 KB).' };
	}
	try {
		return {
			...result,
			before: decodePreviewText(beforeBytes, { preserveBom: true }),
			after: decodePreviewText(afterBytes, { preserveBom: true }),
		};
	} catch {
		return { ...result, unavailable: 'A text preview isn’t available for this file.' };
	}
}
