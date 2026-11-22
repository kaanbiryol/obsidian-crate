import { parseSharedCheckpointList, parseSharedCheckpointDocument, type SharedCheckpoint, type SharedCheckpointDocument } from '../../protocol/history-checkpoints';
import type { FileEntry } from '../../protocol/sync-types';
import { MAX_CONFIGURABLE_FILE_BYTES } from '../../protocol/sync-limits';
import { HttpError, TRANSFER_TIMEOUT_MS, type WorkerApiHttpClient } from './http';
import type { EncryptedFiles } from '../encryption/encrypted-files';
import { sha256Hex } from '../../platform/sha256';
import { createPathRecord } from '../../protocol/path-record';
import { HistoryVersionUnavailableError } from '../history/source';

export class SharedHistoryApi {
	constructor(private http: WorkerApiHttpClient) {}
	private encryption?: EncryptedFiles;
	/** The last document loaded. A checkpoint's state never changes, so a restore reuses
	 * the comparison's document instead of rebuilding it on the server. */
	private loaded?: SharedCheckpointDocument;
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; this.loaded = undefined; }
	async list(): Promise<SharedCheckpoint[]> {
		return parseSharedCheckpointList(await this.http.requestJson('/sync/checkpoints?all=1'));
	}
	async load(id: string): Promise<SharedCheckpointDocument> {
		if (this.loaded?.checkpoint.id === id) return { ...this.loaded, files: createPathRecord<FileEntry>(this.loaded.files) };
		const result = parseSharedCheckpointDocument(await this.http.requestJson(`/sync/checkpoint?id=${encodeURIComponent(id)}`, {}, TRANSFER_TIMEOUT_MS));
		if (result.checkpoint.id !== id) throw new Error('The server returned a different checkpoint.');
		if (this.encryption) {
			// Checkpoints list server paths; each entry keeps its server path for downloads.
			const wires = Object.keys(result.files);
			const entries = await this.encryption.metadata(wires.map(path => ({ path, entry: result.files[path]! })), { historical: true });
			result.files = createPathRecord<FileEntry>();
			for (const { path, wire, entry } of entries) result.files[path] ??= { ...entry, wire };
		}
		this.loaded = result;
		return { ...result, files: createPathRecord<FileEntry>(result.files) };
	}
	async download(id: string, path: string, file: FileEntry): Promise<ArrayBuffer> {
		const wire = this.encryption ? file.wire ?? await this.encryption.paths.wireFor(path) : path;
		let body: ArrayBuffer;
		try {
			({ body } = await this.http.requestBinary(`/sync/checkpoint-file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(wire)}&revision=${encodeURIComponent(file.revision ?? '')}`, {}, TRANSFER_TIMEOUT_MS));
		} catch (error) {
			if (error instanceof HttpError && error.status === 410 && error.code === 'version_unavailable') throw new HistoryVersionUnavailableError(path);
			throw error;
		}
		if (this.encryption) body = (await this.encryption.download(wire, body, { expected: path, historical: true })).content;
		if (body.byteLength > MAX_CONFIGURABLE_FILE_BYTES || body.byteLength !== file.size || await sha256Hex(body) !== file.hash) throw new Error(`${path}: checkpoint file failed integrity validation.`);
		return body;
	}
}
