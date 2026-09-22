import { adoptReadingClip, createReadingNote, parseReadingNote, updateReadingNote } from '../core/notes';
import { MAX_READING_BYTES, readingUrlIdentity, type ReadingChanges, type ReadingItem, type ReadingMetadata } from '../core/model';
import { readReadingFrontmatter } from '../core/frontmatter';

export interface ReadingFile { path: string; size: number; revision?: string }
export interface ReadingVault {
	files(): ReadingFile[];
	read(file: ReadingFile): Promise<string>;
	/** Must apply synchronously to current bytes and reject deleted/replaced files. */
	process(file: ReadingFile, update: (current: string) => string): Promise<string>;
	create(path: string, content: string): Promise<void>;
}
interface ReadingIssue { path: string; message: string }
export interface ReadingSnapshot { items: ReadingItem[]; issues: ReadingIssue[]; loading: boolean; error: string | null }

export class ReadingLibrary {
	private snapshot: ReadingSnapshot = { items: [], issues: [], loading: true, error: null };
	private listeners = new Set<() => void>();
	private queue: Promise<void> = Promise.resolve();
	private cache = new Map<string, { revision: string; metadata: ReadingMetadata | null }>();
	constructor(private vault: ReadingVault, readonly folder: string, private signal: AbortSignal,
		private canAdopt: () => boolean = () => true) {}
	getSnapshot = (): ReadingSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	private publish(snapshot: ReadingSnapshot): void {
		if (this.signal.aborted) return;
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = () => { this.signal.throwIfAborted(); return work(); };
		const pending = this.queue.then(run, run);
		this.queue = pending.then(() => undefined, () => undefined);
		return pending;
	}
	refresh(): Promise<void> { return this.enqueue(() => this.scan()); }
	invalidate(path: string): void {
		for (const cachedPath of this.cache.keys()) if (cachedPath === path || cachedPath.startsWith(`${path}/`)) this.cache.delete(cachedPath);
	}
	private async scan(): Promise<void> {
		const items: ReadingItem[] = [];
		const issues: ReadingIssue[] = [];
		try {
			const files = this.vault.files();
			const paths = new Set(files.map(file => file.path));
			for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
			for (const file of files) {
				this.signal.throwIfAborted();
				if (file.size > MAX_READING_BYTES) { issues.push({ path: file.path, message: 'File exceeds the 1 MB reading limit.' }); continue; }
				const cached = this.cache.get(file.path);
				if (cached && file.revision && cached.revision === file.revision) {
					if (cached.metadata) items.push({ ...cached.metadata, path: file.path });
					continue;
				}
				try {
					let content = await this.vault.read(file);
					// Ordinary notes are never adopted or rewritten just for being in this folder.
					if (!/^[ \t]*["']?crate_reading_(?:version|import)["']?:/m.test(content.slice(0, 64 * 1024))) {
						if (file.revision) this.cache.set(file.path, { revision: file.revision, metadata: null });
						continue;
					}
					if (this.canAdopt()) {
						const original = content;
						const adopted = await adoptReadingClip(original, file.path);
						this.signal.throwIfAborted();
						if (adopted !== original) content = await this.vault.process(file, current => {
							this.signal.throwIfAborted();
							if (!this.canAdopt() || current !== original) throw new Error('File changed during import. It will be checked again.');
							return adopted;
						});
					}
					const metadata = parseReadingNote(content);
					if (metadata) {
						items.push({ ...metadata, path: file.path });
						if (file.revision) this.cache.set(file.path, { revision: file.revision, metadata });
					}
					else if (readReadingFrontmatter(content)?.value.crate_reading_import) issues.push({ path: file.path, message: 'Clip is waiting for import after sync.' });
				} catch (error) {
					this.cache.delete(file.path);
					this.signal.throwIfAborted();
					issues.push({ path: file.path, message: error instanceof Error ? error.message : 'Could not read this note.' });
				}
			}
			const counts = new Map<string, number>();
			for (const item of items) counts.set(item.crate_reading_id, (counts.get(item.crate_reading_id) ?? 0) + 1);
			const unique = items.filter(item => {
				if (counts.get(item.crate_reading_id) === 1) return true;
				issues.push({ path: item.path, message: 'Another note has the same reading ID. Resolve the duplicate before editing here.' });
				return false;
			});
			unique.sort((a, b) => b.saved_at.localeCompare(a.saved_at) || a.crate_reading_id.localeCompare(b.crate_reading_id));
			this.publish({ items: unique, issues, loading: false, error: null });
		} catch (error) {
			if (this.signal.aborted) return;
			this.publish({ ...this.snapshot, loading: false, error: error instanceof Error ? error.message : 'Could not load reading notes.' });
			throw error;
		}
	}
	add(url: string, title?: string): Promise<{ item: ReadingItem; duplicate: boolean }> {
		return this.enqueue(async () => {
			await this.scan();
			const identity = readingUrlIdentity(url);
			const matches = this.snapshot.items.filter(item => readingUrlIdentity(item.source_url) === identity);
			if (matches.length > 1) throw new Error('Multiple notes already save this link. Open reading to choose one.');
			const existing = matches[0];
			if (existing) return { item: existing, duplicate: true };
			const id = crypto.randomUUID();
			const path = `${this.folder}/${id}.md`;
			const content = createReadingNote({ id, url, title, savedAt: new Date().toISOString() });
			this.signal.throwIfAborted();
			await this.vault.create(path, content);
			await this.scan();
			return { item: { ...parseReadingNote(content)!, path }, duplicate: false };
		});
	}
	read(item: ReadingItem): Promise<{ item: ReadingItem; markdown: string }> {
		return this.enqueue(async () => {
			const file = this.vault.files().find(file => file.path === item.path);
			if (!file) throw new Error('This reading note was moved or deleted.');
			const content = await this.vault.read(file);
			this.signal.throwIfAborted();
			const metadata = parseReadingNote(content);
			if (!metadata || metadata.crate_reading_id !== item.crate_reading_id) throw new Error('This reading note changed. Refresh before opening it.');
			return { item: { ...metadata, path: file.path }, markdown: readReadingFrontmatter(content)!.body };
		});
	}
	update(item: ReadingItem, changes: ReadingChanges): Promise<void> {
		return this.enqueue(async () => {
			await this.scan();
			if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict. Refresh before trying again.');
			const file = this.vault.files().find(file => file.path === item.path);
			if (!file) throw new Error('This reading note was moved or deleted.');
			await this.vault.process(file, content => {
				this.signal.throwIfAborted();
				const current = parseReadingNote(content);
				if (!current) throw new Error('This is no longer a reading note.');
				for (const key of Object.keys(changes) as (keyof ReadingChanges)[]) {
					if (JSON.stringify(current[key]) !== JSON.stringify(item[key])) throw new Error('This property changed elsewhere. Refresh before trying again.');
				}
				return updateReadingNote(content, item.crate_reading_id, changes);
			});
			await this.scan();
		});
	}
}
