import type { DataAdapter } from 'obsidian';
import { createAbortError } from '../abort';
import { createReminderOperationId, reminderOperationDay } from '@/protocol/reminder-operation';
import { isRecord } from '@/platform/validation';
import { validateUploadIntent, type IntendedUpload, type JournalUpload, type PrepareUploadWire } from './upload-intent';
import { sha256Hex } from '@/platform/sha256';

export const UPLOAD_JOURNAL_VERSION = 1;

/** A record whose write never reached its final name. Its request was never dispatched. */
export const isUnfinishedUploadRecord = (path: string): boolean => path.endsWith('.json.tmp');

/** One immutable file per dispatched upload, separate from the large manifest.
 * Receipts are removed only after their resulting checkpoint is durable. */
export class UploadJournal {
	private entries = new Map<string, JournalUpload>();
	private completed = new Set<string>();
	// Operations whose bytes are saved beside their record, so pruning removes only those.
	private withContent = new Set<string>();
	private writing: Promise<void> = Promise.resolve();
	private closed = false;
	private sequence = 0;
	private directoryReady = false;
	constructor(private adapter: DataAdapter, private directory: string, private authority?: string) {}

	async load(settled: unknown = []): Promise<void> {
		if (!Array.isArray(settled) || settled.some(id => typeof id !== 'string' || reminderOperationDay(id) === null)) throw new Error('Invalid upload receipt checkpoint');
		this.completed = new Set(settled as string[]);
		if (!await this.adapter.exists(this.directory)) { this.completed.clear(); return; }
		const listing = await this.adapter.list(this.directory);
		const present = new Set(listing.files);
		this.completed = new Set([...this.completed].filter(id => present.has(this.path(id))));
		const ordered: Array<{ file: JournalUpload; sequence: number }> = [];
		for (const path of listing.files) {
			if (path.endsWith('/.DS_Store')) continue;
			// A chunked upload's bytes, read with its record. Without a record it was never dispatched.
			if (path.endsWith('.bin')) {
				if (!present.has(`${path.slice(0, -4)}.json`)) {
					try { await this.adapter.remove(path); } catch { /* Ignored again on the next load. */ }
				}
				continue;
			}
			// Discard an interrupted write. A final record for the same id is read on its own.
			if (isUnfinishedUploadRecord(path)) {
				try { await this.adapter.remove(path); } catch { /* Still never dispatched; ignored on every load. */ }
				continue;
			}
			const fileId = path.slice(this.directory.length + 1, -5);
			if (path === this.path(fileId) && this.completed.has(fileId)) {
				if (present.has(`${this.directory}/${fileId}.bin`)) this.withContent.add(fileId);
				continue;
			}
			let raw: unknown;
			try { raw = JSON.parse(await this.adapter.read(path)); } catch { throw new Error('Unreadable upload journal. Preserve the vault and its sync metadata before resetting.'); }
			if (!isRecord(raw) || raw.authority !== this.authority || !isRecord(raw.file)) throw new Error('Upload journal belongs to another server or is damaged. Preserve it before resetting sync.');
			const file = raw.file;
			const chunked = file.contentFile !== undefined;
			if (raw.version !== UPLOAD_JOURNAL_VERSION) throw new Error('Unsupported upload journal. Preserve pending uploads and compare local and remote files before continuing.');
			if (chunked && !present.has(`${this.directory}/${String(file.contentFile)}`)) throw new Error('A pending upload lost its saved bytes. Preserve the vault and compare local and remote files before resetting sync.');
			if (chunked) this.withContent.add(fileId);
			if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) throw new Error('Invalid upload journal sequence');
			this.sequence = Math.max(this.sequence, raw.sequence);
			if (typeof file.operationId !== 'string' || reminderOperationDay(file.operationId) === null
				|| path !== this.path(file.operationId)) throw new Error('Invalid upload journal. Preserve this vault and its metadata before resetting sync.');
			await validateUploadIntent(file);
			if (!this.completed.has(file.operationId)) ordered.push({ file: file as unknown as JournalUpload, sequence: raw.sequence });
		}
		for (const { file } of ordered.sort((a, b) => a.sequence - b.sequence)) this.entries.set(file.operationId, file);
	}

	pending(): JournalUpload[] { return [...this.entries.values()].filter(file => !this.completed.has(file.operationId)); }
	completedSnapshot(): string[] { return [...this.completed]; }
	complete(id: string): void { this.entries.delete(id); this.completed.add(id); }

	/** Records a chunked upload: `bytes` are saved beside the record, never as base64 in it. */
	async prepareChunked(file: Omit<IntendedUpload, 'content' | 'intent'>, bytes: ArrayBuffer, day: number, clientSession: string = crypto.randomUUID()): Promise<JournalUpload> {
		return this.prepareOne({ ...file, content: '', intent: { kind: 'local' } }, day, clientSession, undefined, bytes);
	}

	/** A chunked upload's saved bytes, checked against its record. */
	async readContent(file: JournalUpload): Promise<ArrayBuffer> {
		if (!file.contentFile) throw new Error('This upload keeps its bytes in its record');
		const bytes = await this.adapter.readBinary(`${this.directory}/${file.contentFile}`);
		if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.hash) throw new Error('A pending upload\'s saved bytes are damaged. Preserve the vault and compare local and remote files before resetting sync.');
		return bytes;
	}

	async prepare(files: IntendedUpload[], day: number, clientSession: string = crypto.randomUUID(), prepareWire?: PrepareUploadWire): Promise<JournalUpload[]> {
		const result: JournalUpload[] = [];
		for (const file of files) result.push(await this.prepareOne(file, day, clientSession, prepareWire));
		return result;
	}

	/** Encrypts outside the write chain, so concurrent batches only serialize
	 * sequence assignment and the journal write. */
	private async prepareOne(file: IntendedUpload, day: number, clientSession: string, prepareWire?: PrepareUploadWire, bytes?: ArrayBuffer): Promise<JournalUpload> {
		if (this.closed) throw createAbortError('Sync engine closed');
		const seal = async (): Promise<JournalUpload> => {
			const operationId = file.operationId ?? createReminderOperationId(day);
			const durable: JournalUpload = { ...file, origin: { clientSession, at: new Date().toISOString() }, operationId, ...(bytes ? { contentFile: `${operationId}.bin` } : {}) };
			this.assertNewOperation(durable.operationId);
			const encryptedWire = await prepareWire?.(durable);
			// Sealing already hashed this plaintext and ciphertext; check only the shape.
			if (encryptedWire) { durable.encryptedWire = encryptedWire; await validateUploadIntent(durable, true); }
			return durable;
		};
		const sealed = this.pendingFor(file.path) ? undefined : await seal();
		const task = this.writing.catch(() => {}).then(async () => {
			if (this.closed) throw createAbortError('Sync engine closed');
			const prior = this.pendingFor(file.path);
			if (prior) {
				if (prior.hash !== file.hash || prior.content !== file.content || prior.expectedHash !== file.expectedHash || prior.contentType !== file.contentType || prior.size !== file.size || JSON.stringify(prior.intent) !== JSON.stringify(file.intent)) throw new Error('An earlier upload is unresolved. Sync again to recover its receipt before sending new changes.');
				return prior;
			}
			// The earlier pending upload settled while this one waited.
			const durable = sealed ?? await seal();
			this.assertNewOperation(durable.operationId);
			if (!this.directoryReady) {
				if (!await this.adapter.exists(this.directory)) await this.adapter.mkdir(this.directory);
				this.directoryReady = true;
			}
			// A failed write must not dispatch the request. Adapter writes are not atomic,
			// so the record is written beside its final name and renamed: an interrupted
			// write leaves only a temporary file, and a damaged final record still fails closed.
			const path = this.path(durable.operationId);
			const temporary = `${path}.tmp`;
			const contentPath = durable.contentFile && `${this.directory}/${durable.contentFile}`;
			try {
				// A record already at this name may have been sent; never replace it.
				if (await this.adapter.exists(path)) throw new Error('Invalid or reused upload operation identity');
				// The bytes land before the record, so a record never names missing bytes.
				if (contentPath && bytes) await this.adapter.writeBinary(contentPath, bytes);
				await this.adapter.write(temporary, JSON.stringify({ version: UPLOAD_JOURNAL_VERSION, authority: this.authority, sequence: ++this.sequence, file: durable }));
				await this.adapter.rename(temporary, path);
			} catch (error) {
				this.directoryReady = false;
				try { await this.adapter.remove(temporary); } catch { /* Removed on the next load. */ }
				if (contentPath) try { await this.adapter.remove(contentPath); } catch { /* Removed on the next load. */ }
				throw error;
			}
			this.entries.set(durable.operationId, durable);
			if (contentPath) this.withContent.add(durable.operationId);
			return durable;
		});
		this.writing = task.then(() => {}, () => {});
		return task;
	}

	private pendingFor(path: string): JournalUpload | undefined {
		for (const file of this.entries.values()) if (file.path === path && !this.completed.has(file.operationId)) return file;
		return undefined;
	}

	private assertNewOperation(id: string): void {
		if (reminderOperationDay(id) === null || this.entries.has(id) || this.completed.has(id)) throw new Error('Invalid or reused upload operation identity');
	}

	async pruneCompleted(ids: string[]): Promise<void> {
		for (const id of ids) {
			try { await this.adapter.remove(this.path(id)); } catch { continue; }
			// Bytes without their record are removed on the next load if this fails, or if
			// this session never knew of them.
			if (this.withContent.delete(id)) try { await this.adapter.remove(`${this.directory}/${id}.bin`); } catch { /* See above. */ }
			this.entries.delete(id);
			this.completed.delete(id);
		}
	}

	async close(): Promise<void> { this.closed = true; await this.writing.catch(() => {}); }
	private path(id: string): string { return `${this.directory}/${id}.json`; }
}
