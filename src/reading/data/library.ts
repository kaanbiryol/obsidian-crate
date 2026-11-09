import { youtubeVideoId } from '../core/youtube';
import { enrichReadingBookmark } from '../core/duplicates';
import { findSavedReadingLink, READING_DUPLICATE_ID_ISSUE } from '../core/inventory';
import { applyLocalArticle } from '../core/article';
import { isEmptyReadingCapture, readingUpdateIssue } from '../core/mutation-policy';
import type { CapturedArticle } from '../extraction/types';
import { readingCapturePath, retitledCapturePath } from '../core/filename';
import { portablePathKey } from '@/protocol/portable-path';
import { adoptReadingClip, createReadingNote, parseReadingNote, recordMarkdownHighlights, updateReadingNote } from '../core/notes';
import { MAX_READING_BYTES, readingUrlIdentity, validateReadingMetadata, type ReadingChanges, type ReadingItem, type ReadingMetadata } from '../core/model';
import { patchReadingFrontmatter, readReadingFrontmatter } from '../core/frontmatter';

export interface ReadingFile { path: string; size: number; modifiedAt: number; revision?: string }
export interface ReadingVault {
	captureArticle?: (url: string, signal: AbortSignal) => Promise<CapturedArticle>;
	occupied?(path: string): boolean;
	/** True while an editor has the note open; background writes wait until it closes. */
	editing?(path: string): boolean;
	files(): ReadingFile[];
	read(file: ReadingFile): Promise<string>;
	/** Must apply synchronously to current bytes and reject deleted/replaced files. */
	process(file: ReadingFile, update: (current: string) => string): Promise<string>;
	create(path: string, content: string): Promise<void>;
	/** Renames through the host so links to the note follow it. */
	rename?(file: ReadingFile, path: string): Promise<void>;
	/** The current note at `path`, without listing the folder. */
	file?(path: string): ReadingFile | null;
	/** The host's cached frontmatter for `file`, or undefined while it has not indexed the note.
	 * Lets the library list notes without reading them. */
	cachedProperties?(file: ReadingFile): Record<string, unknown> | undefined;
}
interface ReadingIssue { path: string; message: string }
/** One note as the library last loaded it. */
interface ReadingEntry {
	/** The revision it was loaded at; an entry without one loads again on the next full scan. */
	revision?: string;
	item?: ReadingItem;
	issue?: string;
	/** Properties came from the host's frontmatter cache; the note itself was not read. */
	cached: boolean;
	/** An import or highlight record waits until sync stops changing vault files. */
	pending: boolean;
	/** An import or highlight record waits until no editor has the note open. */
	deferred: boolean;
}
const SIZE_ISSUE = 'File exceeds the 1 MB reading limit.';
const newestFirst = (a: ReadingItem, b: ReadingItem) => b.saved_at.localeCompare(a.saved_at) || a.crate_reading_id.localeCompare(b.crate_reading_id);
export interface ReadingSnapshot { items: ReadingItem[]; issues: ReadingIssue[]; loading: boolean; error: string | null }

export class ReadingLibrary {
	private snapshot: ReadingSnapshot = { items: [], issues: [], loading: true, error: null };
	private listeners = new Set<() => void>();
	private queue: Promise<void>;
	private closed = false;
	private closing: Promise<void> | undefined;
	private captures = new Map<string, Promise<ReadingItem>>();
	private captureErrors = new Map<string, string>();
	private captureQueue: Promise<void> = Promise.resolve();
	// Each note's item keeps its identity while the note is unchanged.
	private entries = new Map<string, ReadingEntry>();
	// Every listed item, newest first, kept in order as single notes change.
	private sorted: ReadingItem[] = [];
	// Paths per Reading ID; an ID with several paths is a duplicate.
	private idPaths = new Map<string, Set<string>>();
	// Notes changed since they were loaded; they are read, not taken from cached frontmatter.
	private stale = new Set<string>();
	// A full scan has listed the folder, so single notes can be updated on their own.
	private listed = false;
	private highlightsChecked = false;
	// URL identities by item; an unchanged note keeps its item, so each is normalized once.
	private urlIdentities = new WeakMap<ReadingItem, string>();
	// The last parsed note: an update's rescan and reread see the same bytes.
	private parsed: { content: string; metadata: ReadingMetadata | null } | undefined;
	// Notes whose import or highlight records wait until no editor has them open.
	private deferred = new Set<string>();
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
	/** Lists the whole folder. Startup uses it; later changes use `refreshPaths`. */
	refresh(): Promise<void> { return this.enqueue(() => this.scan()); }
	/** Reads the notes at `paths` again, such as after vault events, and updates only their cards. */
	refreshPaths(paths: Iterable<string>): Promise<void> {
		const list = [...new Set(paths)];
		for (const path of list) this.stale.add(path);
		return this.enqueue(() => this.scanPaths(list));
	}
	/** Updates cards whose properties the host re-indexed, without reading notes the library
	 * already read in this session: their vault events cover them. */
	refreshProperties(paths: Iterable<string>): Promise<void> {
		return this.enqueue(() => this.scanPaths([...new Set(paths)].filter(path => {
			const entry = this.entries.get(path);
			return !entry || entry.cached;
		})));
	}
	/** Retries imports and highlight records that waited for sync or an open editor. */
	retryPending(): Promise<void> {
		return this.enqueue(() => this.scanPaths([...this.entries].filter(([, entry]) => entry.pending || entry.deferred).map(([path]) => path)));
	}
	/** Highlights listed from cached frontmatter can predate edits made while Obsidian was
	 * closed; the Highlights tab reads those notes once per session. */
	checkHighlights(): Promise<void> {
		if (this.highlightsChecked) return Promise.resolve();
		this.highlightsChecked = true;
		return this.enqueue(async () => {
			if (!this.listed) await this.scan();
			const paths = [...this.entries].filter(([, entry]) => entry.cached && entry.item?.highlights?.length).map(([path]) => path);
			for (const path of paths) this.stale.add(path);
			await this.scanPaths(paths);
		});
	}
	private parse(content: string): ReadingMetadata | null {
		if (this.parsed?.content === content) return this.parsed.metadata;
		const metadata = parseReadingNote(content);
		this.parsed = { content, metadata };
		return metadata;
	}
	invalidate(path: string): void { this.stale.add(path); }
	/** True while the last scan left a note for when its editor closes. */
	get waitingForEditor(): boolean { return this.deferred.size > 0; }
	private isNotePath(path: string): boolean { return path.startsWith(`${this.folder}/`) && /\.md$/i.test(path); }
	private findFile(path: string): ReadingFile | undefined {
		return (this.vault.file ? this.vault.file(path) ?? undefined : this.vault.files().find(file => file.path === path));
	}
	/** A note's properties from the host's cache, when they describe a valid, imported note. */
	private cachedMetadata(file: ReadingFile): ReadingMetadata | null {
		const properties = this.vault.cachedProperties?.(file);
		if (!properties || !Object.prototype.hasOwnProperty.call(properties, 'crate_reading_version')) return null;
		// An invalid cached value falls back to reading the note, whose strict check reports it.
		try {
			const metadata = validateReadingMetadata(properties);
			return { ...metadata, tags: [...metadata.tags] };
		} catch { return null; }
	}
	private reusable(entry: ReadingEntry, file: ReadingFile): boolean {
		return entry.revision !== undefined && entry.revision === file.revision && !this.stale.has(file.path)
			&& !entry.pending && !entry.deferred && (entry.item !== undefined || entry.issue === SIZE_ISSUE);
	}
	private async loadEntry(file: ReadingFile): Promise<ReadingEntry> {
		const base = { revision: file.revision, cached: false, pending: false, deferred: false };
		if (file.size > MAX_READING_BYTES) return { ...base, issue: SIZE_ISSUE };
		if (!this.stale.has(file.path)) {
			const metadata = this.cachedMetadata(file);
			if (metadata) return { ...base, cached: true, item: { ...metadata, path: file.path } };
		}
		this.stale.delete(file.path);
		try {
			let original = await this.vault.read(file);
			// Versioned notes need no adoption, so parse them only once.
			let metadata = this.parse(original);
			let deferred = false, pending = false, written = false;
			if (!metadata && !this.canAdopt()) pending = true;
			if (!metadata && this.canAdopt()) {
				const adopted = await adoptReadingClip(original, file.path, new Date(file.modifiedAt).toISOString());
				this.assertActive();
				// Like highlight records below, an import waits until nobody is editing the note.
				if (adopted !== original && this.vault.editing?.(file.path)) deferred = true;
				else {
					const content = adopted === original ? original : await this.vault.process(file, current => {
						this.assertActive();
						if (!this.canAdopt() || current !== original) throw new Error('File changed during import. It will be checked again.');
						return adopted;
					});
					written = content !== original;
					metadata = this.parse(content);
					original = content;
				}
			}
			// Markers typed in Obsidian get stable IDs once nobody is editing the note.
			const typedHighlights = metadata?.highlights?.some(highlight => highlight.id?.startsWith('markdown-'));
			if (typedHighlights && !this.canAdopt()) pending = true;
			if (metadata && typedHighlights && this.canAdopt()) {
				const recorded = await recordMarkdownHighlights(original, metadata);
				this.assertActive();
				if (recorded !== original && this.vault.editing?.(file.path)) deferred = true;
				else if (recorded !== original) {
					const content = await this.vault.process(file, current => {
						this.assertActive();
						return current === original ? recorded : current;
					});
					written = true;
					metadata = this.parse(content);
					// A concurrent edit wins; its own change event schedules another scan.
					deferred = content !== recorded;
				}
			}
			// A write changed the revision; the note's change event reads it again.
			const entry = { ...base, ...(written ? { revision: undefined } : {}), pending, deferred };
			if (metadata) return { ...entry, item: { ...metadata, path: file.path } };
			return { ...entry, issue: deferred ? 'Close this note to add it to Reading.' : 'Note is waiting for import after sync.' };
		} catch (error) {
			this.assertActive();
			return { cached: false, pending: false, deferred: false, issue: error instanceof Error ? error.message : 'Could not read this note.' };
		}
	}
	/** Replaces one note's entry, keeping the sorted list and duplicate IDs current. */
	private apply(path: string, entry: ReadingEntry | undefined): void {
		const previous = this.entries.get(path)?.item;
		if (previous) {
			const index = this.sorted.indexOf(previous);
			if (index >= 0) this.sorted.splice(index, 1);
			const paths = this.idPaths.get(previous.crate_reading_id);
			paths?.delete(path);
			if (paths?.size === 0) this.idPaths.delete(previous.crate_reading_id);
		}
		if (!entry) {
			this.entries.delete(path); this.deferred.delete(path); this.captureErrors.delete(path);
			return;
		}
		this.entries.set(path, entry);
		if (entry.deferred) this.deferred.add(path); else this.deferred.delete(path);
		if (!entry.item) return;
		const item = entry.item;
		let low = 0, high = this.sorted.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (newestFirst(this.sorted[middle]!, item) <= 0) low = middle + 1; else high = middle;
		}
		this.sorted.splice(low, 0, item);
		const paths = this.idPaths.get(item.crate_reading_id) ?? new Set<string>();
		paths.add(path);
		this.idPaths.set(item.crate_reading_id, paths);
	}
	/** Rebuilds the sorted list and duplicate IDs from every entry in one pass. */
	private rebuild(): void {
		this.sorted = []; this.idPaths.clear(); this.deferred.clear();
		for (const [path, entry] of this.entries) {
			if (entry.deferred) this.deferred.add(path);
			if (!entry.item) continue;
			this.sorted.push(entry.item);
			const paths = this.idPaths.get(entry.item.crate_reading_id) ?? new Set<string>();
			paths.add(path);
			this.idPaths.set(entry.item.crate_reading_id, paths);
		}
		this.sorted.sort(newestFirst);
	}
	private publishLibrary(): void {
		const unique = this.sorted.filter(item => this.idPaths.get(item.crate_reading_id)?.size === 1);
		const issues: ReadingIssue[] = [...this.captureErrors].map(([path, message]) => ({ path, message }));
		for (const [path, entry] of this.entries) if (entry.issue) issues.push({ path, message: entry.issue });
		for (const [path, entry] of this.entries) if (entry.item && (this.idPaths.get(entry.item.crate_reading_id)?.size ?? 0) > 1) issues.push({ path, message: READING_DUPLICATE_ID_ISSUE });
		// Rescans after unrelated changes find the same notes; keep listeners quiet.
		const previous = this.snapshot;
		if (previous.loading || previous.error !== null || previous.items.length !== unique.length || previous.issues.length !== issues.length
			|| previous.items.some((item, index) => item !== unique[index])
			|| previous.issues.some((issue, index) => issue.path !== issues[index]!.path || issue.message !== issues[index]!.message)) {
			this.publish({ items: unique, issues, loading: false, error: null });
		}
	}
	private failed(error: unknown): void {
		if (this.closed || this.signal.aborted) return;
		this.publish({ ...this.snapshot, loading: false, error: error instanceof Error ? error.message : 'Could not load reading notes.' });
		throw error;
	}
	private async scan(): Promise<void> {
		try {
			this.assertActive();
			const files = this.vault.files().filter(file => this.isNotePath(file.path));
			const paths = new Set(files.map(file => file.path));
			for (const path of [...this.entries.keys()]) if (!paths.has(path)) this.entries.delete(path);
			// A failed download is reported until its note is retried, moved or deleted.
			for (const path of this.captureErrors.keys()) if (!paths.has(path)) this.captureErrors.delete(path);
			for (const file of files) {
				this.assertActive();
				const existing = this.entries.get(file.path);
				if (existing && this.reusable(existing, file)) continue;
				this.entries.set(file.path, await this.loadEntry(file));
			}
			this.rebuild();
			this.listed = true;
			this.publishLibrary();
		} catch (error) { this.failed(error); }
	}
	/** Loads only `paths`. Before the first full scan, or for a path that is not a note (such
	 * as a renamed folder), it lists the whole folder instead. */
	private async scanPaths(paths: string[]): Promise<void> {
		if (!paths.length) return;
		if (!this.listed || !this.vault.file || paths.some(path => !this.isNotePath(path))) return this.scan();
		try {
			for (const path of paths) {
				this.assertActive();
				const file = this.vault.file(path);
				this.apply(path, file && this.isNotePath(file.path) ? await this.loadEntry(file) : undefined);
			}
			this.publishLibrary();
		} catch (error) { this.failed(error); }
	}
	/** The first full listing; duplicate-link checks need every note. */
	private async ensureListed(): Promise<void> { if (!this.listed) await this.scan(); }
	/** Reads `paths` again before or after a write, so an action sees and leaves current cards. */
	private async reload(paths: string[]): Promise<void> {
		for (const path of paths) this.stale.add(path);
		await this.scanPaths([...new Set(paths)]);
	}
	add(url: string, title?: string, fetchArticle = true): Promise<{ item: ReadingItem; duplicate: boolean }> {
		return this.enqueue(async () => {
			await this.ensureListed();
			const saved = findSavedReadingLink(this.snapshot.items, url, item => {
				let identity = this.urlIdentities.get(item);
				if (identity === undefined) { identity = readingUrlIdentity(item.source_url); this.urlIdentities.set(item, identity); }
				return identity;
			});
			if (saved.kind === 'many') throw new Error('Multiple notes already save this link. Open reading to choose one.');
			if (saved.kind === 'one') return { item: saved.item, duplicate: true };
			const id = crypto.randomUUID();
			const note = createReadingNote({ id, url, title, savedAt: new Date().toISOString() });
			const content = patchReadingFrontmatter(note, { extraction_status: 'unavailable' });
			const metadata = parseReadingNote(content)!;
			const path = await readingCapturePath(this.folder, { title: metadata.title, url: metadata.source_url }, id, candidate => this.occupied(candidate));
			this.assertActive();
			await this.vault.create(path, content);
			await this.reload([path]);
			const item = { ...metadata, path };
			if (fetchArticle && this.vault.captureArticle) void this.retryCapture(item).catch(() => { /* The saved bookmark and library issue retain the failure. */ });
			return { item, duplicate: false };
		});
	}
	get canCaptureLocally(): boolean { return Boolean(this.vault.captureArticle); }
	private occupied(path: string): boolean {
		return this.vault.occupied?.(path) ?? this.vault.files().some(file => portablePathKey(file.path) === portablePathKey(path));
	}
	enrich(target: ReadingItem, clip: ReadingItem): Promise<void> {
		return this.enqueue(async () => {
			await this.reload([target.path, clip.path]);
			const destination = this.findFile(target.path), source = this.findFile(clip.path);
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
			await this.reload([target.path, clip.path]);
		});
	}
	isCapturing(item: ReadingItem): boolean { return this.captures.has(item.crate_reading_id); }
	/** Resolves with the note as saved, which may have a new path once its title is known. */
	retryCapture(item: ReadingItem): Promise<ReadingItem> {
		try { this.assertActive(); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Reading library is stopped.')); }
		const existing = this.captures.get(item.crate_reading_id);
		if (existing) return existing;
		const capture = this.vault.captureArticle;
		if (!capture || !item.path) return Promise.reject(new Error('Local article downloads are unavailable.'));
		this.captureErrors.delete(item.path);
		const work = this.captureQueue.then(async () => {
			// Network work runs outside the mutation queue: saved notes remain editable.
			const file = await this.enqueue(async () => {
				await this.reload([item.path]);
				if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict.');
				const file = this.findFile(item.path);
				if (!file) throw new Error('This reading note was moved or deleted.');
				const content = await this.vault.read(file), metadata = parseReadingNote(content);
				if (metadata?.crate_reading_id !== item.crate_reading_id || metadata.source_url !== item.source_url
					|| !(['unavailable', 'pending'].includes(metadata.extraction_status) || youtubeVideoId(metadata.source_url)) || !isEmptyReadingCapture(content, metadata)) throw new Error('Only empty saved links can be downloaded.');
				return file;
			});
			this.assertActive();
			const article = await capture(item.source_url, this.signal);
			return this.enqueue(async () => {
				await this.reload([item.path]);
				if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict.');
				const written: { before?: ReadingMetadata | null } = {};
				const saved = parseReadingNote(await this.vault.process(file, content => {
					this.assertActive();
					written.before = parseReadingNote(content);
					return applyLocalArticle(content, item, article);
				}))!;
				this.invalidate(item.path);
				let path = item.path;
				// A note still named after its link takes the downloaded title; a user rename is kept.
				const previous = written.before;
				const renamed = this.vault.rename && previous ? await retitledCapturePath(item.path, this.folder, { title: previous.title, url: previous.source_url },
					{ title: saved.title, url: saved.source_url }, item.crate_reading_id,
					candidate => portablePathKey(candidate) !== portablePathKey(item.path) && this.occupied(candidate)) : undefined;
				if (renamed && this.vault.rename) {
					this.assertActive();
					// The article is saved either way; a failed rename only keeps the old name.
					path = renamed;
					await this.vault.rename(file, renamed).catch(() => { path = item.path; });
				}
				await this.reload([item.path, path]);
				return { ...saved, path };
			});
		}).catch((error: unknown) => {
			if (!this.closed && !this.signal.aborted) this.captureErrors.set(item.path, `Link saved. ${error instanceof Error ? error.message : 'Article download failed.'}`);
			throw error;
		}).finally(() => {
			this.captures.delete(item.crate_reading_id);
			if (!this.closed && !this.signal.aborted) void this.refreshPaths([item.path]).catch(() => { /* Refresh already publishes its error. */ });
		});
		this.captures.set(item.crate_reading_id, work);
		this.captureQueue = work.then(() => undefined, () => undefined);
		this.publish({ ...this.snapshot });
		return work;
	}
	read(item: ReadingItem): Promise<{ item: ReadingItem; markdown: string }> {
		return this.enqueue(async () => {
			if (!item.path) return { item, markdown: '' };
			const file = this.findFile(item.path);
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
			await this.reload([item.path]);
			if (!this.snapshot.items.some(current => current.path === item.path && current.crate_reading_id === item.crate_reading_id)) throw new Error('This note moved or has an identity conflict. Refresh before trying again.');
			const file = this.findFile(item.path);
			if (!file) throw new Error('This reading note was moved or deleted.');
			await this.vault.process(file, content => {
				this.assertActive();
				const current = this.parse(content);
				if (!current) throw new Error('This is no longer a reading note.');
				if (readingUpdateIssue(current, item, changes)) throw new Error('This property changed elsewhere. Refresh before trying again.');
				return updateReadingNote(content, item.crate_reading_id, changes, current);
			});
			await this.reload([item.path]);
		});
	}
}
