import type { DataAdapter } from 'obsidian';
import type { BatchUploadFile } from '@/protocol/sync-types';
import { createReminderOperationId, reminderOperationDay } from '@/protocol/reminder-operation';
import { isRecord } from '@/plugin/settings';
import { getPortablePathIssue } from '@/protocol/portable-path';

export type JournalUpload = BatchUploadFile & { operationId: string };

/** One immutable file per dispatched upload, separate from the large manifest.
 * Receipts are removed only after their resulting checkpoint is durable. */
export class UploadJournal {
	private entries = new Map<string, JournalUpload>();
	private completed = new Set<string>();
	private writing: Promise<void> = Promise.resolve();
	private closed = false;
	private sequence = 0;
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
			const fileId = path.slice(this.directory.length + 1, -5);
			if (path === this.path(fileId) && this.completed.has(fileId)) continue;
			let raw: unknown;
			try { raw = JSON.parse(await this.adapter.read(path)); } catch { throw new Error('Unreadable upload journal. Preserve the vault and its sync metadata before resetting.'); }
			if (!isRecord(raw) || raw.authority !== this.authority || !isRecord(raw.file)) throw new Error('Upload journal belongs to another server or is damaged. Preserve it before resetting sync.');
			const file = raw.file;
			if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) throw new Error('Invalid upload journal sequence');
			this.sequence = Math.max(this.sequence, raw.sequence);
			if (typeof file.operationId !== 'string' || reminderOperationDay(file.operationId) === null
				|| path !== this.path(file.operationId) || typeof file.path !== 'string' || getPortablePathIssue(file.path) !== null
				|| typeof file.content !== 'string' || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)
				|| typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 25 * 1024 * 1024
				|| typeof file.contentType !== 'string' || !(file.expectedHash === null || typeof file.expectedHash === 'string')) throw new Error('Invalid upload journal. Preserve this vault and its metadata before resetting sync.');
			if (!this.completed.has(file.operationId)) ordered.push({ file: file as unknown as JournalUpload, sequence: raw.sequence });
		}
		for (const { file } of ordered.sort((a, b) => a.sequence - b.sequence)) this.entries.set(file.operationId, file);
	}

	pending(): JournalUpload[] { return [...this.entries.values()].filter(file => !this.completed.has(file.operationId)); }
	completedSnapshot(): string[] { return [...this.completed]; }
	complete(id: string): void { this.entries.delete(id); this.completed.add(id); }

	prepare(files: BatchUploadFile[], day: number): Promise<JournalUpload[]> {
		const task = this.writing.catch(() => {}).then(async () => {
			if (this.closed) throw new DOMException('Sync engine closed', 'AbortError');
			if (!await this.adapter.exists(this.directory)) await this.adapter.mkdir(this.directory);
			const result: JournalUpload[] = [];
			for (const file of files) {
				const prior = this.pending().find(item => item.path === file.path);
				if (prior) {
					if (prior.hash !== file.hash || prior.content !== file.content || prior.expectedHash !== file.expectedHash || prior.contentType !== file.contentType || prior.size !== file.size) throw new Error('An earlier upload is unresolved. Sync again to recover its receipt before sending new changes.');
					result.push(prior);
					continue;
				}
				const durable = { ...file, operationId: file.operationId ?? createReminderOperationId(day) };
				if (reminderOperationDay(durable.operationId) === null || (this.entries.has(durable.operationId) || this.completed.has(durable.operationId))) throw new Error('Invalid or reused upload operation identity');
				// A failed write must not dispatch the request. A partial journal file
				// makes restart fail closed instead of guessing that no upload ran.
				await this.adapter.write(this.path(durable.operationId), JSON.stringify({ authority: this.authority, sequence: ++this.sequence, file: durable }));
				this.entries.set(durable.operationId, durable);
				result.push(durable);
			}
			return result;
		});
		this.writing = task.then(() => {}, () => {});
		return task;
	}

	async pruneCompleted(ids: string[]): Promise<void> {
		for (const id of ids) {
			try { await this.adapter.remove(this.path(id)); } catch { continue; }
			this.entries.delete(id);
			this.completed.delete(id);
		}
	}

	async close(): Promise<void> { this.closed = true; await this.writing.catch(() => {}); }
	private path(id: string): string { return `${this.directory}/${id}.json`; }
}
