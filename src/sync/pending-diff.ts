import type { DataAdapter } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { assertLocalSyncPath } from './local-path-safety';
import { computeHash } from './hasher';
import { isBinaryPreviewPath } from './preview-format';

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

const MAX_PREVIEW_BYTES = 256_000;

/** Read a snapshot for display only; never advance the manifest or sync queue. */
export async function loadPendingDiff(
    adapter: Pick<DataAdapter, 'stat' | 'readBinary'>,
    baseline: FileEntry | undefined,
    readBase: (path: string, hash: string) => Promise<ArrayBuffer | null>,
    path: string,
    deleted: boolean,
): Promise<PendingDiff> {
    assertLocalSyncPath(path);
    const local = await adapter.stat(path);
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
    const afterBytes = deleted ? new ArrayBuffer(0) : await adapter.readBinary(path);
    if (afterBytes.byteLength > MAX_PREVIEW_BYTES) {
        return { ...result, afterSize: afterBytes.byteLength, unavailable: 'This file is too large to preview (limit: 256 KB).' };
    }
    // A matching last-synced hash needs no cached contents, including for config files.
    const unchanged = !deleted && !!baseline && await computeHash(afterBytes) === baseline.hash;
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
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        const beforeText = decoder.decode(beforeBytes), afterText = decoder.decode(afterBytes);
        // Allow tabs and line endings, but do not render binary control characters.
        const binary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/; // eslint-disable-line no-control-regex -- Detect binary bytes before rendering text.
        if (binary.test(beforeText) || binary.test(afterText)) throw new Error('Binary file');
        return { ...result, before: beforeText, after: afterText };
    } catch {
        return { ...result, unavailable: 'A text preview isn’t available for this file.' };
    }
}
