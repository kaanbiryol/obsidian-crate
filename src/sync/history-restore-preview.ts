import type { FileEntry } from '../protocol/sync-types';
import { computeHash } from './hasher';
import { isBinaryPreviewPath } from './preview-format';

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
    if ((current?.size ?? 0) > 256_000 || (target?.size ?? 0) > 256_000) {
        return { unavailable: 'This file is too large to compare (limit: 256 KB). You can still restore this point.' };
    }
    const read = async (entry: FileEntry | undefined, load: () => Promise<ArrayBuffer>) => {
        if (!entry) return new ArrayBuffer(0);
        const bytes = await load();
        if (bytes.byteLength > 256_000 || await computeHash(bytes) !== entry.hash) {
            throw new Error('The file changed or its saved version is unavailable. Review the restore again.');
        }
        return bytes;
    };
    const before = await read(current, readCurrent);
    const after = await read(target, readTarget);
    try {
        const decode = (bytes: ArrayBuffer) => {
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            // eslint-disable-next-line no-control-regex -- Binary controls must not be shown as a text diff.
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('Not text');
            return text;
        };
        return { current: decode(before), saved: decode(after) };
    } catch {
        return { unavailable: 'This file is not valid UTF-8 text. You can still restore this point.' };
    }
}
