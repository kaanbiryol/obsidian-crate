import { parseSharedCheckpoint, parseSharedCheckpointList, parseSharedCheckpointDocument, type SharedCheckpoint } from '../../protocol/history-checkpoints';
import { isRecord } from '../../platform/validation';
import type { FileEntry } from '../../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { TRANSFER_TIMEOUT_MS, type WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encryption/encrypted-files';
import { sha256Hex } from '../../platform/sha256';
import { createPathRecord } from '../../protocol/path-record';

export class SharedHistoryApi {
    constructor(private http: WorkerApiHttpClient) {}
    private encryption?: EncryptedFiles;
    setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; }
    async save(): Promise<SharedCheckpoint | undefined> {
        const result: unknown = await this.http.requestJson('/sync/checkpoints', { method: 'POST', body: '{}' }, TRANSFER_TIMEOUT_MS);
        if (!isRecord(result)) throw new Error('Invalid shared checkpoint response');
        return parseSharedCheckpoint(result.checkpoint);
    }
    async list(): Promise<SharedCheckpoint[]> {
        return parseSharedCheckpointList(await this.http.requestJson('/sync/checkpoints'));
    }
    async load(id: string) {
        const result = parseSharedCheckpointDocument(await this.http.requestJson(`/sync/checkpoint?id=${encodeURIComponent(id)}`, {}, TRANSFER_TIMEOUT_MS));
        if (result.checkpoint.id !== id) throw new Error('The server returned a different checkpoint.');
        if (this.encryption) {
            // Checkpoints list server paths; each entry keeps its server path for downloads.
            const wires = Object.keys(result.files);
            const entries = await this.encryption.metadata(wires.map(path => ({ path, entry: result.files[path]! })), false);
            result.files = createPathRecord<FileEntry>();
            for (const { path, wire, entry } of entries) result.files[path] ??= { ...entry, wire };
        }
        return result;
    }
    async download(id: string, path: string, file: FileEntry): Promise<ArrayBuffer> {
        const wire = this.encryption ? file.wire ?? await this.encryption.paths.wireFor(path) : path;
        let { body } = await this.http.requestBinary(`/sync/checkpoint-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(wire)}&revision=${encodeURIComponent(file.revision ?? '')}`, {}, TRANSFER_TIMEOUT_MS);
        if (this.encryption) body = (await this.encryption.download(wire, body, undefined, path, false)).content;
        if (body.byteLength > MAX_FILE_SIZE_BYTES || body.byteLength !== file.size || await sha256Hex(body) !== file.hash) throw new Error(`${path}: checkpoint file failed integrity validation.`);
        return body;
    }
}
