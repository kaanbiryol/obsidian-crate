import type { MarkdownBaseCache } from './markdown-base-cache';
import type { BatchUploadFile, BatchUploadResponse, UploadResult } from '@/protocol/sync-types';
import type { LocalManifest } from './manifest';
import { base64ToArrayBuffer } from './encoding';
import type { JournalUpload } from './upload-journal';
import { HttpError } from './worker-api/http';

interface UploadTransport {
	getServerInfo(): Promise<{ reminderOperationDay?: number }>;
	batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse>;
	uploadFile(path: string, content: ArrayBuffer, hash: string, size: number, contentType: string, expectedHash: string | null, operationId?: string): Promise<UploadResult>;
}

export class DurableUploads {
	private recovering: Promise<void> | null = null;
	private active = new Set<string>();
	private serverDay?: { day: number; expires: number };
	constructor(private manifest: LocalManifest, private transport: UploadTransport, private cache: MarkdownBaseCache) {}

	async batch(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		const durable = await this.prepare(files);
		for (const file of durable) this.active.add(file.operationId);
		try {
			const response = await this.transport.batchUpload(durable);
			if (response.results.length !== durable.length || new Set(response.results.map(file => file.path)).size !== durable.length) throw new Error('Invalid upload receipt batch');
			for (const file of durable) this.validate(file, response.results.find(result => result.path === file.path));
			for (const file of durable) await this.accept(file, response.results.find(result => result.path === file.path)!);
			return response;
		} finally { for (const file of durable) this.active.delete(file.operationId); }
	}

	async single(file: BatchUploadFile): Promise<UploadResult> {
		const [durable] = await this.prepare([file]);
		return this.sendSingle(durable!);
	}

	/** Replay original bytes before reading state for a new reconciliation plan. */
	recover(): Promise<void> {
		if (this.recovering) return this.recovering;
		this.recovering = (async () => {
			const pending = this.manifest.uploadJournal.pending().filter(file => !this.active.has(file.operationId));
			for (const file of pending) {
				const result = await this.sendSingle(file, true);
				if (!result.success && !this.definitive(result)) throw new Error(result.error ?? 'An upload receipt is unresolved');
			}
			if (pending.length) await this.manifest.save();
		})().finally(() => { this.recovering = null; });
		return this.recovering;
	}

	private async prepare(files: BatchUploadFile[]): Promise<JournalUpload[]> {
		if (!this.serverDay || this.serverDay.expires <= performance.now()) {
			const info = await this.transport.getServerInfo();
			if (!Number.isInteger(info.reminderOperationDay)) throw new Error('Server did not provide an upload retry window. Update the server before syncing.');
			this.serverDay = { day: info.reminderOperationDay!, expires: performance.now() + 60_000 };
		}
		return this.manifest.uploadJournal.prepare(files, this.serverDay.day);
	}

	private async sendSingle(file: JournalUpload, recovering = false): Promise<UploadResult> {
		this.active.add(file.operationId);
		try {
			let result: UploadResult;
			try {
				result = await this.transport.uploadFile(file.path, base64ToArrayBuffer(file.content), file.hash, file.size, file.contentType, file.expectedHash, file.operationId);
			} catch (error) {
				if (!(error instanceof HttpError) || !['version_conflict', 'namespace_conflict'].includes(error.code ?? '')) throw error;
				result = { success: false, path: file.path, status: error.status, code: error.code as 'version_conflict' | 'namespace_conflict', error: error.message };
			}
			this.validate(file, result);
			await this.accept(file, result, recovering);
			return result;
		} finally { this.active.delete(file.operationId); }
	}

	private definitive(result: UploadResult): boolean {
		return result.status === 409 && (result.code === 'version_conflict' || result.code === 'namespace_conflict');
	}
	private validate(file: JournalUpload, result?: UploadResult): void {
		if (!result || result.path !== file.path || (result.success && (result.hash !== file.hash || !result.revision))) throw new Error('Server returned an invalid upload receipt; the original upload is preserved for recovery');
	}
	private async accept(file: JournalUpload, result: UploadResult, recovering = false): Promise<void> {
		if (result.success) {
			this.manifest.setEntry(file.path, { hash: file.hash, revision: result.revision, size: file.size, modified: new Date().toISOString() });
			if (recovering) await this.cache.putBase(file.path, file.hash, base64ToArrayBuffer(file.content));
		}
		if (result.success || this.definitive(result)) this.manifest.completeUpload(file.operationId);
	}
}
