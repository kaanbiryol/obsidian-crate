import { createReminderOperationId } from '@/protocol/reminder-operation';
import { createReadingNote, parseReadingNote } from '../core/notes';
import { readingUrlIdentity, type ReadingItem } from '../core/model';

export interface CaptureStorage {
	list(): Promise<string[]>;
	read(key: string): Promise<string>;
	write(key: string, value: string): Promise<void>;
	remove(key: string, operationId: string): Promise<void>;
}
export interface CaptureRecord { version: 1; authority: string; folder: string; note: string; body: { captureId: string; operationId: string; url: string; title?: string; fetchArticle: true; destinationFolder: string } }

export function parseCaptureRecord(raw: string): CaptureRecord {
  const value = JSON.parse(raw) as CaptureRecord;
  if (!value || value.version !== 1 || typeof value.authority !== 'string' || typeof value.folder !== 'string' || typeof value.note !== 'string' || !value.body) throw new Error('A pending Reading save needs recovery. Its original file has been preserved.');
  const item = parseReadingNote(value.note);
  if (!item || value.body.captureId !== item.crate_reading_id || value.body.url !== item.source_url || value.body.destinationFolder !== value.folder || value.body.fetchArticle !== true || typeof value.body.operationId !== 'string') throw new Error('A pending Reading save needs recovery. Its original file has been preserved.');
  return value;
}

export async function captureAuthority(origin: string, token: string | null): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([origin, token])));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

/** Immutable, per-save records survive restart and uncertain server responses. */
export class ReadingCaptureOutbox {
	private acknowledged = new Set<string>();
	private work: Promise<unknown> = Promise.resolve();
	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const next = this.work.then(action, action);
		this.work = next.catch(() => undefined);
		return next;
	}
	constructor(private storage: CaptureStorage, private authority: string, private folder: string, private signal: AbortSignal, private aliases: string[] = []) {}
	private async entries(): Promise<Array<{ key: string; value: CaptureRecord; item: ReadingItem }>> {
		const result = [];
		for (const key of await this.storage.list()) {
			const value = parseCaptureRecord(await this.storage.read(key));
			const item = parseReadingNote(value.note)!;
			if (![this.authority, ...this.aliases].includes(value.authority) || value.folder !== this.folder) throw new Error('Pending Reading saves belong to another server or folder. Restore that connection to finish saving them.');
			result.push({ key, value, item: { ...item, path: '' } });
		}
		this.signal.throwIfAborted();
		return result;
	}
	add(url: string, title?: string): Promise<ReadingItem> {
		return this.serialize(async () => {
			const entries = await this.entries();
			const existing = entries.find(entry => readingUrlIdentity(entry.item.source_url) === readingUrlIdentity(url));
			if (existing) return existing.item;
			if (entries.length >= 200) throw new Error('Finish pending Reading saves before adding more links.');
			const id = crypto.randomUUID(), savedAt = new Date().toISOString();
			const note = createReadingNote({ id, url, title, savedAt });
			const item = parseReadingNote(note)!;
			const value: CaptureRecord = { version: 1, authority: this.authority, folder: this.folder, note,
				body: { captureId: id, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)), url: item.source_url,
					...(title === undefined ? {} : { title }), fetchArticle: true, destinationFolder: this.folder } };
			this.signal.throwIfAborted();
			await this.storage.write(`${id}.json`, JSON.stringify(value));
			return { ...item, path: '' };
		});
	}
	list(): Promise<ReadingItem[]> { return this.serialize(async () => (await this.entries()).map(entry => entry.item)); }
	waitForIdle(): Promise<void> { return this.work.then(() => undefined, () => undefined); }
	async drain(confirmed: ReadingItem[], send: (body: CaptureRecord['body']) => Promise<unknown>): Promise<void> {
		for (const entry of await this.serialize(() => this.entries())) {
			this.signal.throwIfAborted();
			if (confirmed.some(item => item.path && (item.crate_reading_id === entry.item.crate_reading_id || item.source_url && readingUrlIdentity(item.source_url) === readingUrlIdentity(entry.item.source_url)))) {
				await this.serialize(() => this.storage.remove(entry.key, entry.value.body.operationId));
			} else if (!this.acknowledged.has(entry.key)) {
				// Keep the exact request until the final note has arrived through normal sync.
				await send(entry.value.body);
				this.acknowledged.add(entry.key);
			}
		}
	}
}
