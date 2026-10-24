import { youtubeVideoId } from '../core/youtube';
import { enrichReadingBookmark } from '../core/duplicates';
import { applyLocalArticle } from '../core/article';
import { isEmptyReadingCapture, readingUpdateIssue } from '../core/mutation-policy';
import type { CapturedArticle } from '../extraction/types';
import { readingCapturePath } from '../core/filename';
import { portablePathKey } from '@/protocol/portable-path';
import { adoptReadingClip, createReadingNote, parseReadingNote, recordMarkdownHighlights, updateReadingNote } from '../core/notes';
import { MAX_READING_BYTES, readingUrlIdentity, type ReadingChanges, type ReadingItem, type ReadingMetadata } from '../core/model';
import { patchReadingFrontmatter, readReadingFrontmatter } from '../core/frontmatter';

export interface ReadingFile { path: string; size: number; modifiedAt: number; revision?: string }
export interface ReadingVault {
	privateFilenames?(): boolean;
	captureArticle?: (url: string, signal: AbortSignal) => Promise<CapturedArticle>;
	occupied?(path: string): boolean;
	/** True while an editor has the note open; background writes wait until it closes. */
	editing?(path: string): boolean;
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
	private queue: Promise<void>;
	private closed = false;
	private closing: Promise<void> | undefined;
	private captures = new Map<string, Promise<void>>();
	private captureErrors = new Map<string, string>();
	private captureQueue: Promise<void> = Promise.resolve();
	// The cached item keeps its identity while the note is unchanged.
	private cache = new Map<string, { revision: string; metadata: ReadingMetadata | null; item?: ReadingItem }>();
	// The last parsed note: an update's rescan and reread see the same bytes.
	private parsed: { content: string; metadata: ReadingMetadata | null } | undefined;
	constructor(private vault: ReadingVault, readonly folder: string, private signal: AbortSignal,
		private canAdopt: () => boolean = () => true, startAfter: Promise<void> = Promise.resolve()) {
		this.queue = startAfter;
	}
	getSnapshot = (): ReadingSnapshot => this.snapshot;
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	private publish(snapshot: ReadingSnapshot): void {
		if (this.closed || this.signal.aborted) return;
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		try { this.assertActive(); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Reading library is stopped.')); }
		const run = () => { this.assertActive(); return work(); };
		const pending = this.queue.then(run, run);
		this.queue = pending.then(() => undefined, () => undefined);
		return pending;
	}
	private assertActive(): void {
		this.signal.throwIfAborted();
		if (this.closed) throw new Error('Reading library is stopped.');
	}
	/** Accepted host writes cannot be cancelled; drain both queues before replacing their owner. */
	close(): Promise<void> {
		this.closed = true;
		return this.closing ??= Promise.allSettled([this.queue, this.captureQueue]).then(() => {});
	}
	refresh(): Promise<void> { return this.enqueue(() => this.scan()); }
	private parse(content: string): ReadingMetadata | null {
		if (this.parsed?.content === content) return this.parsed.metadata;
		const metadata = parseReadingNote(content);
		this.parsed = { content, metadata };
		return metadata;
	}
	invalidate(path: string): void {
		for (const cachedPath of this.cache.keys()) if (cachedPath === path || cachedPath.startsWith(`${path}/`)) this.cache.delete(cachedPath);
	}
	private async scan(): Promise<void> {
		const items: ReadingItem[] = [];
		const issues: ReadingIssue[] = [...this.captureErrors].map(([path, message]) => ({ path, message }));
		try {
			this.assertActive();
			const files = this.vault.files().filter(file => file.path.startsWith(`${this.folder}/`) && /\.md$/i.test(file.path));
			const paths = new Set(files.map(file => file.path));
			for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
			for (const file of files) {
				this.assertActive();
				if (file.size > MAX_READING_BYTES) { issues.push({ path: file.path, message: 'File exceeds the 1 MB reading limit.' }); continue; }
				const cached = this.cache.get(file.path);
				if (cached && file.revision && cached.revision === file.revision) {
					if (cached.metadata) items.push(cached.item ??= { ...cached.metadata, path: file.path });
					continue;
				}
				try {
					let original = await this.vault.read(file);
					// Versioned notes need no adoption, so parse them only once.
					let metadata = this.parse(original);
					if (!metadata && this.canAdopt()) {
						const adopted = await adoptReadingClip(original, file.path, new Date(file.modifiedAt).toISOString());
						this.assertActive();
						const content = adopted === original ? original : await this.vault.process(file, current => {
							this.assertActive();
							if (!this.canAdopt() || current !== original) throw new Error('File changed during import. It will be checked again.');
							return adopted;
						});
						metadata = this.parse(content);
						original = content;
					}
					// Markers typed in Obsidian get stable IDs once nobody is editing the note.
					let deferred = false;
					if (metadata?.highlights?.some(highlight => highlight.id?.startsWith('markdown-')) && this.canAdopt()) {
						const recorded = await recordMarkdownHighlights(original);
						this.assertActive();
						if (recorded !== original && this.vault.editing?.(file.path)) deferred = true;
						else if (recorded !== original) {
							const content = await this.vault.process(file, current => {
								this.assertActive();
								return current === original ? recorded : current;
							});
							metadata = this.parse(content);
							// A concurrent edit wins; its own change event schedules another scan.
							deferred = content !== recorded;
						}
					}
					if (metadata) {
						const item = { ...metadata, path: file.path };
						items.push(item);
						if (file.revision && !deferred) this.cache.set(file.path, { revision: file.revision, metadata, item });
					}
					else issues.push({ path: file.path, message: 'Note is waiting for import after sync.' });
				} catch (error) {
					this.cache.delete(file.path);
					this.assertActive();
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
			// Rescans after unrelated changes find the same notes; keep listeners quiet.
			const previous = this.snapshot;
			if (previous.loading || previous.error !== null || previous.items.length !== unique.length || previous.issues.length !== issues.length
				|| previous.items.some((item, index) => item !== unique[index])
				|| previous.issues.some((issue, index) => issue.path !== issues[index]!.path || issue.message !== issues[index]!.message)) {
				this.publish({ items: unique, issues, loading: false, error: null });
			}
		} catch (error) {
			if (this.closed || this.signal.aborted) return;
			this.publish({ ...this.snapshot, loading: false, error: error instanceof Error ? error.message : 'Could not load reading notes.' });
			throw error;
		}
	}
	add(url: string, title?: string, fetchArticle = true): Promise<{ item: ReadingItem; duplicate: boolean }> {
		return this.enqueue(async () => {
			await this.scan();
			const identity = readingUrlIdentity(url);
			const matches = this.snapshot.items.filter(item => item.source_url && readingUrlIdentity(item.source_url) === identity);
			if (matches.length > 1) throw new Error('Multiple notes already save this link. Open reading to choose one.');
			const existing = matches[0];
			if (existing) return { item: existing, duplicate: true };
			const id = crypto.randomUUID();
			const note = createReadingNote({ id, url, title, savedAt: new Date().toISOString() });
			const content = patchReadingFrontmatter(note, { extraction_status: 'unavailable' });
			const path = await readingCapturePath(this.folder, this.vault.privateFilenames?.() ? 'Article' : parseReadingNote(content)!.title, id, candidate => this.vault.occupied?.(candidate) ?? this.vault.files().some(file => portablePathKey(file.path) === portablePathKey(candidate)));
			this.assertActive();
			await this.vault.create(path, content);
			await this.scan();
			const item = { ...parseReadingNote(content)!, path };
			if (fetchArticle && this.vault.captureArticle) void this.retryCapture(item).catch(() => { /* The saved bookmark and library issue retain the failure. */ });
			return { item, duplicate: false };
		});
	}
	get canCaptureLocally(): boolean { return Boolean(this.vault.captureArticle); }
	enrich(target: ReadingItem, clip: ReadingItem): Promise<void> {
		return this.enqueue(async () => {
			await this.scan();
			const files = this.vault.files(), destination = files.find(file => file.path === target.path), source = files.find(file => file.path === clip.path);
			if (!destination || !source) throw new Error('A note moved or was deleted. Refresh Reading.');
			const [before, clipped] = await Promise.all([this.vault.read(destination), this.vault.read(source)]);
			if (parseReadingNote(before)?.crate_reading_id !== target.crate_reading_id || parseReadingNote(clipped)?.crate_reading_id !== clip.crate_reading_id) throw new Error('A note changed. Refresh Reading.');
			const next = enrichReadingBookmark(before, clipped);
			parseReadingNote(next);
			await this.vault.process(destination, current => {
				this.assertActive();
				if (current !== before) throw new Error('The bookmark changed. Its content has been kept.');
				return next;
			});
			this.invalidate(target.path); await this.scan();
		});
	}
	isCapturing(item: ReadingItem): boolean { return this.captures.has(item.crate_reading_id); }
	retryCapture(item: ReadingItem): Promise<void> {
		try { this.assertActive(); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Reading library is stopped.')); }
		const existing = this.captures.get(item.crate_reading_id);
		if (existing) return existing;
		const capture = this.vault.captureArticle;
		if (!capture || !item.path) return Promise.reject(new Error('Local article downloads are unavailable.'));
		this.captureErrors.delete(item.path);
		const work = this.captureQueue.then(async () => {
			// Network work runs outside the mutation queue: saved notes remain editable.
			const file = await this.enqueue(async () => {
				await this.scan();
				if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict.');
				const file = this.vault.files().find(file => file.path === item.path);
				if (!file) throw new Error('This reading note was moved or deleted.');
				const content = await this.vault.read(file), metadata = parseReadingNote(content);
				if (metadata?.crate_reading_id !== item.crate_reading_id || metadata.source_url !== item.source_url
					|| !(['unavailable', 'pending'].includes(metadata.extraction_status) || youtubeVideoId(metadata.source_url)) || !isEmptyReadingCapture(content, metadata)) throw new Error('Only empty saved links can be downloaded.');
				return file;
			});
			this.assertActive();
			const article = await capture(item.source_url, this.signal);
			await this.enqueue(async () => {
				await this.scan();
				if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict.');
				await this.vault.process(file, content => {
					this.assertActive();
					return applyLocalArticle(content, item, article);
				});
				this.invalidate(item.path);
				await this.scan();
			});
		}).catch((error: unknown) => {
			if (!this.closed && !this.signal.aborted) this.captureErrors.set(item.path, `Link saved. ${error instanceof Error ? error.message : 'Article download failed.'}`);
			throw error;
		}).finally(() => {
			this.captures.delete(item.crate_reading_id);
			if (!this.closed && !this.signal.aborted) void this.refresh().catch(() => { /* Refresh already publishes its error. */ });
		});
		this.captures.set(item.crate_reading_id, work);
		this.captureQueue = work.catch(() => undefined);
		this.publish({ ...this.snapshot });
		return work;
	}
	read(item: ReadingItem): Promise<{ item: ReadingItem; markdown: string }> {
		return this.enqueue(async () => {
			if (!item.path) return { item, markdown: '' };
			const file = this.vault.files().find(file => file.path === item.path);
			if (!file) throw new Error('This reading note was moved or deleted.');
			const content = await this.vault.read(file);
			this.assertActive();
			const metadata = this.parse(content);
			if (!metadata || metadata.crate_reading_id !== item.crate_reading_id) throw new Error('This reading note changed. Refresh before opening it.');
			return { item: { ...metadata, path: file.path }, markdown: readReadingFrontmatter(content)!.body };
		});
	}
	update(item: ReadingItem, changes: ReadingChanges): Promise<void> {
		if (!item.path) return Promise.reject(new Error('The article is still being saved. Try again after it syncs.'));
		return this.enqueue(async () => {
			await this.scan();
			if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict. Refresh before trying again.');
			const file = this.vault.files().find(file => file.path === item.path);
			if (!file) throw new Error('This reading note was moved or deleted.');
			await this.vault.process(file, content => {
				this.assertActive();
				const current = this.parse(content);
				if (!current) throw new Error('This is no longer a reading note.');
				if (readingUpdateIssue(current, item, changes)) throw new Error('This property changed elsewhere. Refresh before trying again.');
				return updateReadingNote(content, item.crate_reading_id, changes, current);
			});
			await this.scan();
		});
	}
}
