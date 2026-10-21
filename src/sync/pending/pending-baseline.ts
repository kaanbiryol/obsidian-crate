import type { FileEntry } from '../../protocol/sync-types';
import type { SyncApiClient } from '../worker-api/client';
import { assertLocalSyncPath } from '../local/local-path-safety';
import { findHistorySource } from '../history/source';
import { sha256Hex } from '../../platform/sha256';

/** Recover the exact last-synced bytes for review or discard, never a newer server version. */
export async function loadRemotePendingBase(
    api: Pick<SyncApiClient, 'getFileMetadata' | 'downloadFile' | 'listFileVersions' | 'previewFileVersion'>,
    path: string,
    baseline: Readonly<FileEntry>,
    maxBytes: number,
): Promise<ArrayBuffer> {
    assertLocalSyncPath(path);
    if (baseline.size > maxBytes) throw new Error(`${path}: the last-synced copy is too large for this operation.`);
    const current = (await api.getFileMetadata([path])).files[path];
    if (current?.hash === baseline.hash && current.size !== baseline.size) {
        throw new Error(`${path}: the last-synced copy could not be verified. Review the file again.`);
    }
    const read = await findHistorySource(api, path, baseline, current);
    const content = await read();
    if (content.byteLength > maxBytes || content.byteLength !== baseline.size || await sha256Hex(content) !== baseline.hash) {
        throw new Error(`${path}: the last-synced copy changed or could not be verified. Review the file again.`);
    }
    return content;
}
