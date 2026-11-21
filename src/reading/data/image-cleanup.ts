import { readingImageFolder } from '../core/article-images';

const READING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEANUP_DELAY_MS = 5000;

export interface ReadingImageCleanupHost {
	folder: string;
	signal: AbortSignal;
	/** The Reading ID of each note in the folder: null for a note without one, undefined for one not indexed yet. */
	noteIds(): Iterable<string | null | undefined>;
	folderExists(path: string): boolean;
	/** Moves a folder to the trash the user chose in Obsidian. */
	trash(path: string): Promise<void>;
	/** True while sync writes vault files, when a deleted note may be about to come back. */
	busy(): boolean;
	delayMs?: number;
}

/**
 * Moves a deleted Reading note's image folder to the trash once no note in the folder has its
 * Reading ID. It waits while sync writes the vault and until every note is indexed, so a note
 * sync replaced or moved, or a copy of the note, keeps its images.
 */
export class ReadingImageCleanup {
	private ids = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(private host: ReadingImageCleanupHost) {
		host.signal.addEventListener('abort', () => { clearTimeout(this.timer); }, { once: true });
	}
	/** A note was deleted; `id` is the Reading ID its last indexed properties had. */
	deleted(id: unknown): void {
		if (typeof id !== 'string' || !READING_ID.test(id)) return;
		this.ids.add(id.toLowerCase());
		this.schedule();
	}
	private schedule(): void {
		if (this.host.signal.aborted) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, this.host.delayMs ?? CLEANUP_DELAY_MS);
	}
	async run(): Promise<void> {
		if (this.host.signal.aborted || !this.ids.size) return;
		if (this.host.busy()) { this.schedule(); return; }
		const present = new Set<string>();
		try {
			for (const id of this.host.noteIds()) {
				if (id === undefined) { this.schedule(); return; }
				if (id) present.add(id.toLowerCase());
			}
		} catch { this.schedule(); return; }
		const ids = new Set(this.ids);
		this.ids.clear();
		for (const id of ids) {
			const path = readingImageFolder(this.host.folder, id);
			if (present.has(id) || !this.host.folderExists(path)) continue;
			// A folder that cannot be moved stays for the user to delete.
			try { await this.host.trash(path); } catch { /* Kept. */ }
		}
	}
}
