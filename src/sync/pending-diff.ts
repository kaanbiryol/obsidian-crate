import type { DataAdapter } from 'obsidian';
import type { SyncApiClient } from './api';
import { assertLocalSyncPath } from './local-path-safety';
import { computeHash } from './hasher';

export interface PendingDiff {
    before?: string;
    after?: string;
    beforeSize: number;
    afterSize: number;
    kind: 'added' | 'modified' | 'deleted';
    unavailable?: string;
    unchanged?: boolean;
}

const MAX_PREVIEW_BYTES = 256_000;
// Some binary formats (including PDFs) can contain valid UTF-8. Never expose
// their storage representation as a text diff, even when decoding would pass.
const BINARY_PATH = /\.(?:pdf|png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|ico|icns|psd|ai|eps|mp3|m4a|aac|wav|flac|ogg|opus|aiff?|mp4|m4v|mov|webm|avi|mkv|mpeg|mpg|zip|gz|bz2|xz|7z|rar|tar|docx?|xlsx?|pptx?|odt|ods|odp|epub|woff2?|ttf|otf|eot|db|sqlite3?|exe|dll|dmg|wasm)$/i;

/** Read a snapshot for display only; never advance the manifest or sync queue. */
export async function loadPendingDiff(
    adapter: Pick<DataAdapter, 'stat' | 'readBinary'>,
    api: Pick<SyncApiClient, 'getFileMetadata' | 'downloadFile'>,
    path: string,
    deleted: boolean,
): Promise<PendingDiff> {
    assertLocalSyncPath(path);
    const [local, metadata] = await Promise.all([adapter.stat(path), api.getFileMetadata([path])]);
    if (deleted ? local !== null : local?.type !== 'file') {
        throw new Error('This file changed. Refresh sync activity to see its latest state.');
    }
    const remote = metadata.files[path];
    const result: PendingDiff = {
        beforeSize: remote?.size ?? 0,
        afterSize: local?.size ?? 0,
        kind: deleted ? 'deleted' : remote ? 'modified' : 'added',
    };
    if (BINARY_PATH.test(path)) {
        return { ...result, unavailable: 'A text preview isn’t available for this file. Open it to review its contents.' };
    }
    if (Math.max(result.beforeSize, result.afterSize) > MAX_PREVIEW_BYTES) {
        return { ...result, unavailable: 'This file is too large to preview (limit: 256 KB).' };
    }
    const afterBytes = deleted ? new ArrayBuffer(0) : await adapter.readBinary(path);
    if (afterBytes.byteLength > MAX_PREVIEW_BYTES) {
        return { ...result, afterSize: afterBytes.byteLength, unavailable: 'This file is too large to preview (limit: 256 KB).' };
    }
    // Most touched config files are identical. Hash locally to avoid downloading them.
    const unchanged = !deleted && !!remote && await computeHash(afterBytes) === remote.hash;
    let beforeBytes = new ArrayBuffer(0);
    if (unchanged) {
        beforeBytes = afterBytes;
        result.unchanged = true;
    } else if (remote) {
        const before = await api.downloadFile(path);
        if (before.hash !== remote.hash || before.revision !== remote.revision) {
            throw new Error('The server copy changed. Try again to load the latest version.');
        }
        beforeBytes = before.content;
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
