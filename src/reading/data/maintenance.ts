import { adoptReadingClip, parseReadingNote, recordMarkdownHighlights } from '../core/notes';
import { MAX_READING_BYTES } from '../core/model';
import type { ReadingFile, ReadingVault } from './library';

type MaintenanceVault = Pick<ReadingVault, 'files' | 'read' | 'process' | 'editing' | 'cachedProperties' | 'file'>;
const SYNC_WAIT = 'Note is waiting for import after sync.';
const EDITOR_WAIT = 'Close this note to add it to Reading.';

/**
 * Reading's background work, which runs whether or not Reading is open: imports clips
 * (notes without `crate_reading_version`), records highlight markers typed in Obsidian,
 * and checks changed notes with the strict parser. It reads a note only when that note
 * changed or still needs work; it keeps no card list.
 */
export class ReadingMaintenance {
	// Notes still to check, in arrival order.
	private todo = new Set<string>();
	// Why a note is not done yet, or why its strict check failed, by path.
	private notes = new Map<string, string>();
	private editorWait = new Set<string>();
	private listeners = new Set<() => void>();
	private queue: Promise<void>;
	private closed = false;
	constructor(private vault: MaintenanceVault, readonly folder: string, private signal: AbortSignal,
		private canAdopt: () => boolean = () => true, startAfter: Promise<void> = Promise.resolve()) {
		this.queue = startAfter;
	}
	/** Problems and waits by path, for the card list. */
	get issues(): ReadonlyMap<string, string> { return this.notes; }
	/** True while a note waits for its editor to close. */
	get waitingForEditor(): boolean { return this.editorWait.size > 0; }
	subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	private isNotePath(path: string): boolean { return path.startsWith(`${this.folder}/`) && /\.md$/i.test(path); }
	/** Finds clips waiting for import from cached properties, without reading notes. A note the
	 * host has not indexed yet is checked when its index arrives, or now without a cache. */
	start(): Promise<void> {
		return this.run(() => {
			for (const file of this.vault.files()) {
				if (!this.isNotePath(file.path)) continue;
				const properties = this.vault.cachedProperties?.(file);
				if (!this.vault.cachedProperties || properties && !Object.prototype.hasOwnProperty.call(properties, 'crate_reading_version')) this.todo.add(file.path);
			}
		});
	}
	/** Checks notes that changed: added, edited here, synced, or re-indexed after a restart. */
	changed(paths: Iterable<string>): Promise<void> {
		return this.run(() => { for (const path of paths) if (this.isNotePath(path)) this.todo.add(path); });
	}
	/** Retries notes that waited for sync or an editor. */
	retry(): Promise<void> { return this.run(() => {}); }
	close(): Promise<void> {
		this.closed = true;
		return this.queue;
	}
	private run(add: () => void): Promise<void> {
		if (this.closed || this.signal.aborted) return Promise.resolve();
		add();
		const work = this.queue.then(() => this.process());
		this.queue = work.catch(() => undefined);
		return work;
	}
	private active(): boolean { return !this.closed && !this.signal.aborted; }
	private set(path: string, message: string | undefined): boolean {
		if (message === undefined ? !this.notes.has(path) : this.notes.get(path) === message) return false;
		if (message === undefined) this.notes.delete(path); else this.notes.set(path, message);
		return true;
	}
	private async process(): Promise<void> {
		let changed = false;
		for (const path of [...this.todo]) {
			if (!this.active()) return;
			const file = this.vault.file ? this.vault.file(path) ?? undefined : this.vault.files().find(entry => entry.path === path);
			if (!file) { this.todo.delete(path); this.editorWait.delete(path); changed = this.set(path, undefined) || changed; continue; }
			const result = await this.check(file);
			if (!this.active()) return;
			if (result.done) this.todo.delete(path);
			if (result.message === EDITOR_WAIT || result.editor) this.editorWait.add(path); else this.editorWait.delete(path);
			changed = this.set(path, result.message) || changed;
		}
		if (changed) for (const listener of this.listeners) listener();
	}
	/** One note's work. `done` is false while it waits for sync or an editor. */
	private async check(file: ReadingFile): Promise<{ done: boolean; message?: string; editor?: boolean }> {
		if (file.size > MAX_READING_BYTES) return { done: true };
		if (!this.canAdopt()) {
			// Without reading, only a note the cache shows as a clip is known to need import.
			const properties = this.vault.cachedProperties?.(file);
			const clip = !properties || !Object.prototype.hasOwnProperty.call(properties, 'crate_reading_version');
			return { done: false, ...(clip ? { message: SYNC_WAIT } : {}) };
		}
		let original: string;
		try { original = await this.vault.read(file); } catch (error) { return { done: true, message: error instanceof Error ? error.message : 'Could not read this note.' }; }
		try {
			const metadata = parseReadingNote(original);
			if (!metadata) {
				const adopted = await adoptReadingClip(original, file.path, new Date(file.modifiedAt).toISOString());
				if (adopted === original || !this.active()) return { done: true };
				// Like highlight records below, an import waits until nobody is editing the note.
				if (this.vault.editing?.(file.path)) return { done: false, message: EDITOR_WAIT };
				await this.vault.process(file, current => {
					if (!this.active() || !this.canAdopt() || current !== original) throw new Error('File changed during import. It will be checked again.');
					return adopted;
				});
				return { done: true };
			}
			const recorded = await recordMarkdownHighlights(original, metadata);
			if (recorded === original || !this.active()) return { done: true };
			// Markers typed in Obsidian get stable IDs once nobody is editing the note.
			if (this.vault.editing?.(file.path)) return { done: false, editor: true };
			// A concurrent edit wins; its own change event schedules another check.
			await this.vault.process(file, current => current === original ? recorded : current);
			return { done: true };
		} catch (error) {
			return { done: true, message: error instanceof Error ? error.message : 'Could not check this note.' };
		}
	}
}
