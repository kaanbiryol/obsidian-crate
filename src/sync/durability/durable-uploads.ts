import { recoveryChunks } from './recovery-chunks';
import { SyncIssueError, withSyncFileContext } from '../issues';
import { isMarkdownPath, type MarkdownBaseCache } from '../merge/markdown-base-cache';
import type { BatchUploadFile, BatchUploadResponse, UploadResult } from '@/protocol/sync-types';
import type { LocalManifest } from '../manifest/manifest';
import { base64ToArrayBuffer } from '../encoding';
import { mergeUploadIntent, uploadWire, type IntendedUpload, type JournalUpload, type PrepareUploadWire } from './upload-intent';
import { UNVERIFIED_MODIFIED } from '../transfer/applied-content';
import type { UploadApplyPhase, UploadPhase } from '../diagnostics/upload-diagnostics';
import { isRefusedWrite, isStalePreparedUpload, refusedUploadResult } from '../failures';
import type { UploadPreconditions } from '../encryption/encrypted-files';
import { sha256Hex } from '@/platform/sha256';
import { isSyncRevision } from '@/protocol/sync-validation';

interface UploadTransport {
	prepareUploadWire?(file: JournalUpload, preconditions?: UploadPreconditions): ReturnType<PrepareUploadWire>;
	/** Resolve encrypted preconditions for a batch in one request instead of one per file. */
	preloadUploadPreconditions?(files: Array<{ path: string; expectedHash: string | null }>): Promise<UploadPreconditions | undefined>;
	assertPreparedUpload?(file: JournalUpload): Promise<void>;
	getServerInfo(): Promise<{ reminderOperationDay?: number }>;
	batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse>;
	uploadFile(path: string, content: ArrayBuffer, hash: string, size: number, contentType: string, expectedHash: string | null, operationId?: string): Promise<UploadResult>;
}

const RECEIPTS_PER_CHECKPOINT = 64;
/** Encrypted uploads name the server path saved with their ciphertext. */
const serverPath = (file: JournalUpload) => file.encryptedWire?.path ?? file.path;

export class DurableUploads {
	private unsavedReceipts = 0;
	private recovering: Promise<void> | null = null;
	private active = new Set<string>();
	private serverDay?: { day: number; expires: number };
	constructor(private manifest: LocalManifest, private transport: UploadTransport, private cache: MarkdownBaseCache, private clientSession: string) {}

	async batch(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		const durable: JournalUpload[] = [];
		const rejected: UploadResult[] = [];
		// Batch-scoped, so unconsumed results cannot satisfy a later upload.
		const preconditions = await this.transport.preloadUploadPreconditions?.(files);
		for (const file of files) {
			try {
				durable.push(...await this.prepare([{ ...file, intent: { kind: 'local' } }], preconditions));
			} catch (error) {
				// Encryption resolves the plaintext precondition before journaling.
				// A stale file has not been dispatched and can reconcile independently.
				if (!isStalePreparedUpload(error)) throw error;
				rejected.push(refusedUploadResult(file.path, error));
			}
		}
		const response = durable.length ? await this.sendBatch(durable) : { success: true, results: [] };
		const results = new Map([...response.results, ...rejected].map(result => [result.path, result]));
		return { success: response.success && rejected.length === 0, results: files.map(file => results.get(file.path)!) };
	}

	private async sendBatch(durable: JournalUpload[], onSettled?: () => Promise<void>): Promise<BatchUploadResponse> {
		for (const file of durable) this.active.add(file.operationId);
		try {
			for (const file of durable) await this.transport.assertPreparedUpload?.(file);
			const response = await this.transport.batchUpload(durable.map(uploadWire));
			if (response.results.length !== durable.length || new Set(response.results.map(file => file.path)).size !== durable.length) throw new Error('Invalid upload receipt batch');
			const receipts = new Map(response.results.map(result => [result.path, result]));
			for (const file of durable) this.validate(file, receipts.get(serverPath(file)));
			for (const file of durable) {
				const receipt = receipts.get(serverPath(file))!;
				await this.accept(file, receipt);
				if (receipt.success || this.definitive(receipt)) await onSettled?.();
			}
			return { ...response, results: response.results.map(result => this.localReceipt(durable.find(file => serverPath(file) === result.path)!, result)) };
		} finally { for (const file of durable) this.active.delete(file.operationId); }
	}

	async single(file: BatchUploadFile, mergePreimage?: ArrayBuffer): Promise<UploadResult> {
		const intent = mergePreimage ? await mergeUploadIntent(mergePreimage) : { kind: 'local' as const };
		const [durable] = await this.prepare([{ ...file, intent }]);
		return this.sendSingle(durable!);
	}

	/** Replay original bytes before reading state for a new reconciliation plan. */
	recover(onProgress?: (current: number, total: number) => void): Promise<void> {
		if (this.recovering) return this.recovering;
		this.recovering = (async () => {
			const pending = this.manifest.uploadJournal.pending().filter(file => !this.active.has(file.operationId));
			let uncheckpointed = 0;
			let completed = 0;
			onProgress?.(0, pending.length);
			const settled = async () => {
				uncheckpointed++;
				onProgress?.(++completed, pending.length);
				if (uncheckpointed >= 16) {
					await this.manifest.save();
					uncheckpointed = 0;
				}
			};
			try {
				for (const chunk of recoveryChunks(pending)) {
					await withSyncFileContext(chunk.map(file => file.path), async () => {
						for (const file of chunk) {
							if (!this.manifest.getUploadDiagnostics().some(row => row.operationId === file.operationId && row.phase === 'prepared')) await this.trace(file, 'prepared');
							await this.trace(file, 'replaying');
						}
						if (chunk.length === 1) {
							const result = await this.sendSingle(chunk[0]!);
							if (!result.success && !this.definitive(result)) throw new Error(result.error ?? 'An upload receipt is unresolved');
							await settled();
						} else {
							const response = await this.sendBatch(chunk, settled);
							const unresolved = response.results.find(result => !result.success && !this.definitive(result));
							if (unresolved) throw new SyncIssueError(unresolved.error ?? 'An upload receipt is unresolved', [{ path: unresolved.path, message: unresolved.error ?? 'An upload receipt is unresolved' }]);
						}
					});
				}
			} finally {
				if (uncheckpointed > 0) await this.manifest.save();
			}
		})().finally(() => { this.recovering = null; });
		return this.recovering;
	}

	private async prepare(files: IntendedUpload[], preconditions?: UploadPreconditions): Promise<JournalUpload[]> {
		if (!this.serverDay || this.serverDay.expires <= performance.now()) {
			const info = await this.transport.getServerInfo();
			if (!Number.isInteger(info.reminderOperationDay)) throw new Error('Server did not provide an upload retry window. Update the server before syncing.');
			this.serverDay = { day: info.reminderOperationDay!, expires: performance.now() + 60_000 };
		}
		const transport = this.transport;
		const prepared = await this.manifest.uploadJournal.prepare(files, this.serverDay.day, this.clientSession,
			transport.prepareUploadWire && (file => transport.prepareUploadWire!(file, preconditions)));
		for (const file of prepared) await this.trace(file, 'prepared');
		return prepared;
	}

	private async sendSingle(file: JournalUpload): Promise<UploadResult> {
		this.active.add(file.operationId);
		try {
			let result: UploadResult;
			try {
				await this.transport.assertPreparedUpload?.(file);
				const wire = uploadWire(file);
				result = await this.transport.uploadFile(wire.path, base64ToArrayBuffer(wire.content), wire.hash, wire.size, wire.contentType, wire.expectedHash, wire.operationId);
			} catch (error) {
				result = refusedUploadResult(file.path, error);
			}
			this.validate(file, result);
			await this.accept(file, result);
			return this.localReceipt(file, result);
		} finally { this.active.delete(file.operationId); }
	}

	private definitive(result: UploadResult): boolean {
		return isRefusedWrite(result.status, result.code);
	}
	private validate(file: JournalUpload, result?: UploadResult): void {
		if (!result || result.path !== serverPath(file) || (result.success && (result.hash !== (file.encryptedWire?.hash ?? file.hash) || !isSyncRevision(result.revision)))) throw new Error('Server returned an invalid upload receipt; the original upload is preserved for recovery');
	}
	private localReceipt(file: JournalUpload, receipt: UploadResult): UploadResult {
		if (!file.encryptedWire) return receipt;
		const wire = file.encryptedWire.path;
		return { ...receipt, path: file.path, ...(receipt.success ? { hash: file.hash } : {}),
			...(receipt.error ? { error: receipt.error.split(wire).join(file.path) } : {}) };
	}
	private async accept(file: JournalUpload, result: UploadResult): Promise<void> {
		if (result.success) {
			await this.trace(file, 'remote-committed');
			// Remote commitment is not local application. A merge's original local
			// snapshot is a virtual ancestor already included in the uploaded result.
			// It remains valid after response loss, local I/O failure, or a new edit.
			const base = file.intent.kind === 'merge' ? file.intent.preimage : file;
			// Only Markdown keeps a merge base; avoid decoding other uploads again.
			if (isMarkdownPath(file.path)) await this.cache.putBase(file.path, base.hash, base64ToArrayBuffer(base.content));
			if (file.intent.kind === 'merge' && !await this.cache.readBase(file.path, base.hash)) throw new Error('The merged upload committed, but its recovery base could not be saved. Pending upload preserved; retry sync after storage is available.');
			this.manifest.setEntry(file.path, { hash: base.hash, size: base.size, modified: UNVERIFIED_MODIFIED,
				...(file.intent.kind === 'local' ? { revision: result.revision } : {}) });
		}
		if (this.definitive(result)) await this.trace(file, 'rejected');
		if (result.success || this.definitive(result)) {
			this.manifest.completeUpload(file.operationId);
			// Each journal file holds a full copy of its upload until a checkpoint
			// records the receipt. Checkpoint periodically, so a large sync does
			// not keep every uploaded byte on disk twice until it finishes.
			if (++this.unsavedReceipts >= RECEIPTS_PER_CHECKPOINT) {
				this.unsavedReceipts = 0;
				await this.manifest.save();
			}
		}
	}

	private async trace(file: JournalUpload, phase: UploadPhase): Promise<void> {
		this.manifest.recordUploadDiagnostic({ clientSession: phase === 'prepared' ? file.origin.clientSession : this.clientSession,
			...(phase === 'prepared' ? { at: file.origin.at } : {}), operationId: file.operationId, phase, kind: file.intent.kind,
			pathHash: await sha256Hex(new TextEncoder().encode(file.path).buffer), uploadHash: file.hash,
			baseHash: file.intent.kind === 'merge' ? file.intent.preimage.hash : file.hash });
	}

	getDiagnostics() { return this.manifest.getUploadDiagnostics(); }

	async recordMergeApplication(path: string, hash: string, phase: UploadApplyPhase): Promise<void> {
		const rows = this.manifest.getUploadDiagnostics();
		if (!rows.some(row => row.kind === 'merge')) return;
		const pathHash = await sha256Hex(new TextEncoder().encode(path).buffer);
		const prior = rows.reverse().find(row => row.kind === 'merge' && row.pathHash === pathHash);
		if (!prior || prior.appliedHash || prior.phase === 'rejected' || !rows.some(row => row.operationId === prior.operationId && row.phase === 'remote-committed')) return;
		this.manifest.recordUploadDiagnostic({ ...prior, at: undefined, clientSession: this.clientSession, phase,
			...(phase === 'local-applied' ? { appliedHash: hash } : {}) });
	}
}
