import type { MarkdownBaseCache } from './markdown-base-cache';
import type { BatchUploadFile, BatchUploadResponse, UploadResult } from '@/protocol/sync-types';
import type { LocalManifest } from './manifest';
import { base64ToArrayBuffer } from './encoding';
import { mergeUploadIntent, type IntendedUpload, type JournalUpload } from './upload-intent';
import { UNVERIFIED_MODIFIED } from './applied-content';
import { computeHash } from './hasher';
import type { UploadApplyPhase, UploadPhase } from './upload-diagnostics';
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
	constructor(private manifest: LocalManifest, private transport: UploadTransport, private cache: MarkdownBaseCache, private clientSession: string) {}

	async batch(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		const durable = await this.prepare(files.map(file => ({ ...file, intent: { kind: 'local' } })));
		for (const file of durable) this.active.add(file.operationId);
		try {
			const response = await this.transport.batchUpload(durable.map(({ intent: _intent, origin: _origin, ...file }) => file));
			if (response.results.length !== durable.length || new Set(response.results.map(file => file.path)).size !== durable.length) throw new Error('Invalid upload receipt batch');
			for (const file of durable) this.validate(file, response.results.find(result => result.path === file.path));
			for (const file of durable) await this.accept(file, response.results.find(result => result.path === file.path)!);
			return response;
		} finally { for (const file of durable) this.active.delete(file.operationId); }
	}

	async single(file: BatchUploadFile, mergePreimage?: ArrayBuffer): Promise<UploadResult> {
		const intent = mergePreimage ? await mergeUploadIntent(mergePreimage) : { kind: 'local' as const };
		const [durable] = await this.prepare([{ ...file, intent }]);
		return this.sendSingle(durable!);
	}

	/** Replay original bytes before reading state for a new reconciliation plan. */
	recover(): Promise<void> {
		if (this.recovering) return this.recovering;
		this.recovering = (async () => {
			const pending = this.manifest.uploadJournal.pending().filter(file => !this.active.has(file.operationId));
			for (const file of pending) {
				if (!this.manifest.getUploadDiagnostics().some(row => row.operationId === file.operationId && row.phase === 'prepared')) await this.trace(file, 'prepared');
				await this.trace(file, 'replaying');
				const result = await this.sendSingle(file);
				if (!result.success && !this.definitive(result)) throw new Error(result.error ?? 'An upload receipt is unresolved');
			}
			if (pending.length) await this.manifest.save();
		})().finally(() => { this.recovering = null; });
		return this.recovering;
	}

	private async prepare(files: IntendedUpload[]): Promise<JournalUpload[]> {
		if (!this.serverDay || this.serverDay.expires <= performance.now()) {
			const info = await this.transport.getServerInfo();
			if (!Number.isInteger(info.reminderOperationDay)) throw new Error('Server did not provide an upload retry window. Update the server before syncing.');
			this.serverDay = { day: info.reminderOperationDay!, expires: performance.now() + 60_000 };
		}
		const prepared = await this.manifest.uploadJournal.prepare(files, this.serverDay.day, this.clientSession);
		for (const file of prepared) await this.trace(file, 'prepared');
		return prepared;
	}

	private async sendSingle(file: JournalUpload): Promise<UploadResult> {
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
			await this.accept(file, result);
			return result;
		} finally { this.active.delete(file.operationId); }
	}

	private definitive(result: UploadResult): boolean {
		return result.status === 409 && (result.code === 'version_conflict' || result.code === 'namespace_conflict');
	}
	private validate(file: JournalUpload, result?: UploadResult): void {
		if (!result || result.path !== file.path || (result.success && (result.hash !== file.hash || !result.revision))) throw new Error('Server returned an invalid upload receipt; the original upload is preserved for recovery');
	}
	private async accept(file: JournalUpload, result: UploadResult): Promise<void> {
		if (result.success) {
			await this.trace(file, 'remote-committed');
			// Remote commitment is not local application. A merge's original local
			// snapshot is a virtual ancestor already included in the uploaded result.
			// It remains valid after response loss, local I/O failure, or a new edit.
			const base = file.intent.kind === 'merge' ? file.intent.preimage : file;
			await this.cache.putBase(file.path, base.hash, base64ToArrayBuffer(base.content));
			if (file.intent.kind === 'merge' && !await this.cache.readBase(file.path, base.hash)) throw new Error('The merged upload committed, but its recovery base could not be saved. Pending upload preserved; retry sync after storage is available.');
			this.manifest.setEntry(file.path, { hash: base.hash, size: base.size, modified: UNVERIFIED_MODIFIED,
				...(file.intent.kind === 'local' ? { revision: result.revision } : {}) });
		}
		if (this.definitive(result)) await this.trace(file, 'rejected');
		if (result.success || this.definitive(result)) this.manifest.completeUpload(file.operationId);
	}

	private async trace(file: JournalUpload, phase: UploadPhase): Promise<void> {
		this.manifest.recordUploadDiagnostic({ clientSession: phase === 'prepared' ? file.origin.clientSession : this.clientSession,
			...(phase === 'prepared' ? { at: file.origin.at } : {}), operationId: file.operationId, phase, kind: file.intent.kind,
			pathHash: await computeHash(new TextEncoder().encode(file.path).buffer), uploadHash: file.hash,
			baseHash: file.intent.kind === 'merge' ? file.intent.preimage.hash : file.hash });
	}

	getDiagnostics() { return this.manifest.getUploadDiagnostics(); }

	async recordMergeApplication(path: string, hash: string, phase: UploadApplyPhase): Promise<void> {
		const rows = this.manifest.getUploadDiagnostics();
		if (!rows.some(row => row.kind === 'merge')) return;
		const pathHash = await computeHash(new TextEncoder().encode(path).buffer);
		const prior = rows.reverse().find(row => row.kind === 'merge' && row.pathHash === pathHash);
		if (!prior || prior.appliedHash || prior.phase === 'rejected' || !rows.some(row => row.operationId === prior.operationId && row.phase === 'remote-committed')) return;
		this.manifest.recordUploadDiagnostic({ ...prior, at: undefined, clientSession: this.clientSession, phase,
			...(phase === 'local-applied' ? { appliedHash: hash } : {}) });
	}
}
