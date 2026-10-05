import type { FileEntry } from '../protocol/sync-types';
import { computeHash } from './hasher';
import { decodePreviewText, isBinaryPreviewPath, MAX_PREVIEW_BYTES } from './preview-format';

export type HistoryRestorePreview = { current: string; saved: string } | { unavailable: string };

/** Read one selected file without staging recovery copies or changing the vault. */
export async function loadHistoryRestorePreview(
    path: string,
    current: FileEntry | undefined,
    target: FileEntry | undefined,
    readCurrent: () => Promise<ArrayBuffer>,
    readTarget: () => Promise<ArrayBuffer>,
): Promise<HistoryRestorePreview> {
    if (isBinaryPreviewPath(path)) return { unavailable: 'Text previews are not available for this file type. You can still restore this point.' };
    if ((current?.size ?? 0) > MAX_PREVIEW_BYTES || (target?.size ?? 0) > MAX_PREVIEW_BYTES) {
        return { unavailable: 'This file is too large to compare (limit: 256 KB). You can still restore this point.' };
    }
    const read = async (entry: FileEntry | undefined, load: () => Promise<ArrayBuffer>) => {
        if (!entry) return new ArrayBuffer(0);
        const bytes = await load();
        if (bytes.byteLength > MAX_PREVIEW_BYTES || await computeHash(bytes) !== entry.hash) {
            throw new Error('The file changed or its saved version is unavailable. Review the restore again.');
        }
        return bytes;
    };
    const before = await read(current, readCurrent);
    const after = await read(target, readTarget);
    try {
        return {
            current: decodePreviewText(before, { preserveBom: true }),
            saved: decodePreviewText(after, { preserveBom: true }),
        };
    } catch {
        return { unavailable: 'This file is not valid UTF-8 text. You can still restore this point.' };
    }
}
