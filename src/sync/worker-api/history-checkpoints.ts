import { SHARED_CHECKPOINT_CAPABILITY, parseSharedCheckpoint, parseSharedCheckpointList, parseSharedCheckpointDocument, type SharedCheckpoint } from '../../protocol/history-checkpoints';
import { isRecord } from '../../plugin/settings';
import { computeHash } from '../hasher';
import type { FileEntry } from '../../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { TRANSFER_TIMEOUT_MS, type WorkerApiHttpClient } from './http';

export class SharedHistoryApi {
    constructor(private http: WorkerApiHttpClient) {}
    async supported(): Promise<boolean> { return (await this.http.getServerInfo()).capabilities.includes(SHARED_CHECKPOINT_CAPABILITY); }
    async save(): Promise<SharedCheckpoint | undefined> {
        if (!await this.supported()) return undefined;
        const result: unknown = await this.http.requestJson('/sync/checkpoints', { method: 'POST', body: '{}' }, TRANSFER_TIMEOUT_MS);
        if (!isRecord(result)) throw new Error('Invalid shared checkpoint response');
        return parseSharedCheckpoint(result.checkpoint);
    }
    async list(): Promise<SharedCheckpoint[]> {
        if (!await this.supported()) throw new Error('Update the Crate server to share history checkpoints across your devices.');
        return parseSharedCheckpointList(await this.http.requestJson('/sync/checkpoints'));
    }
    async load(id: string) {
        const result = parseSharedCheckpointDocument(await this.http.requestJson(`/sync/checkpoint?id=${encodeURIComponent(id)}`, {}, TRANSFER_TIMEOUT_MS));
        if (result.checkpoint.id !== id) throw new Error('The server returned a different checkpoint.');
        return result;
    }
    async download(id: string, path: string, file: FileEntry): Promise<ArrayBuffer> {
        const { body } = await this.http.requestBinary(`/sync/checkpoint-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}&revision=${encodeURIComponent(file.revision ?? '')}`, {}, TRANSFER_TIMEOUT_MS);
        if (body.byteLength > MAX_FILE_SIZE_BYTES || body.byteLength !== file.size || await computeHash(body) !== file.hash) throw new Error(`${path}: checkpoint file failed integrity validation.`);
        return body;
    }
}
