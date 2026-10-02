import { SHARED_CHECKPOINT_CAPABILITY, parseSharedCheckpoint, parseSharedCheckpointList, parseSharedCheckpointDocument, type SharedCheckpoint } from '../../protocol/history-checkpoints';
import { isRecord } from '../../platform/validation';
import { computeHash } from '../hasher';
import type { FileEntry } from '../../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { TRANSFER_TIMEOUT_MS, type WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encrypted-files';

export class SharedHistoryApi {
    constructor(private http: WorkerApiHttpClient) {}
    private encryption?: EncryptedFiles;
    setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; }
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
        const raw: unknown = await this.http.requestJson(`/sync/checkpoint?id=${encodeURIComponent(id)}`, {}, TRANSFER_TIMEOUT_MS);
        const encryptedLegacy = isRecord(raw) && typeof raw.encrypted === 'string';
        if (encryptedLegacy && !this.encryption) throw new Error('Unlock the vault before reading its encrypted history');
        const result = parseSharedCheckpointDocument(encryptedLegacy ? await this.encryption!.openCheckpoint(raw.encrypted as string, id) : raw);
        if (result.checkpoint.id !== id) throw new Error('The server returned a different checkpoint.');
        if (this.encryption && !encryptedLegacy) {
            const paths = Object.keys(result.files);
            const entries = await this.encryption.metadata(paths.map(path => ({ path, entry: result.files[path]! })));
            result.files = Object.fromEntries(paths.map((path, index) => [path, entries[index]!]));
        }
        return result;
    }
    async download(id: string, path: string, file: FileEntry): Promise<ArrayBuffer> {
        let { body } = await this.http.requestBinary(`/sync/checkpoint-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}&revision=${encodeURIComponent(file.revision ?? '')}`, {}, TRANSFER_TIMEOUT_MS);
        if (this.encryption) body = (await this.encryption.download(path, body)).content;
        if (body.byteLength > MAX_FILE_SIZE_BYTES || body.byteLength !== file.size || await computeHash(body) !== file.hash) throw new Error(`${path}: checkpoint file failed integrity validation.`);
        return body;
    }
}
