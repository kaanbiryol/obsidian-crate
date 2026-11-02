import { TFolder, type TAbstractFile } from 'obsidian';
import { pendingChangeKey, type PendingChange } from '../pending/pending-change';
import { isConflictFile } from '../conflict/conflict';
import type { SyncEngine } from '../engine/engine';
import type { VaultEntry } from '../types';

/** The path and kind of an Obsidian file or folder. */
export function vaultEntry(file: TAbstractFile): VaultEntry {
	return { path: file.path, kind: file instanceof TFolder ? 'folder' : 'file' };
}

type EventTarget = Pick<SyncEngine, 'onRawFileChange' | 'onFileChange' | 'onFileDelete' | 'onFileRename' | 'restoreDroppedEvents'>;

/** Admits vault events to the current engine. While closed, events are dropped,
 * except during a startup sync, which records them for replay when it finishes.
 * Conflict copies always reach the engine, which tracks them itself. */
export class VaultEventGate {
	private accepting = false;
	/** Latest change implied by each vault event that arrived during the startup sync,
	 * which does not take events; queued once it finishes. */
	private startupEvents: Map<string, PendingChange['kind'] | 'raw'> | null = null;

	constructor(private readonly engine: () => EventTarget | null, private readonly layoutReady: () => boolean) {}

	get isOpen(): boolean { return this.accepting; }

	/** Stops admitting events and forgets any recorded for replay. */
	close(): void {
		this.accepting = false;
		this.startupEvents = null;
	}

	/** Stops admitting events while one workflow drives the engine directly. */
	pause(): void { this.accepting = false; }

	open(): void { this.accepting = true; }

	/** The startup sync scans the vault after this point; later events are replayed. */
	recordForStartupSync(): void { this.startupEvents = new Map(); }

	/** Opens the gate and replays the events the startup sync dropped; pending
	 * verification settles download echoes and other files that still match their baseline. */
	openAfterStartupSync(engine: EventTarget): void {
		this.accepting = true;
		const events = this.startupEvents;
		this.startupEvents = null;
		if (!events) return;
		const keys: string[] = [];
		for (const [path, kind] of events) {
			if (kind === 'raw') void engine.onRawFileChange(path);
			else keys.push(pendingChangeKey(kind, path));
		}
		engine.restoreDroppedEvents(keys);
	}

	onRawFileChange(path: string): void {
		if (!this.layoutReady()) return;
		if (!this.accepting) {
			// Raw notifications stand in for hidden files only; a vault event for the path wins.
			if (!this.startupEvents?.has(path)) this.startupEvents?.set(path, 'raw');
			return;
		}
		void this.engine()?.onRawFileChange(path);
	}

	onFileChange(file: TAbstractFile): void {
		if (!this.layoutReady()) return;
		const entry = vaultEntry(file);
		if (!this.accepting && !isConflictFile(entry.path)) {
			if (entry.kind === 'file') this.startupEvents?.set(entry.path, 'upload');
			return;
		}
		this.engine()?.onFileChange(entry);
	}

	onFileDelete(file: TAbstractFile): void {
		if (!this.layoutReady()) return;
		const entry = vaultEntry(file);
		if (!this.accepting && !isConflictFile(entry.path)) {
			if (entry.kind === 'file') this.startupEvents?.set(entry.path, 'delete');
			return;
		}
		this.engine()?.onFileDelete(entry);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (!this.layoutReady()) return;
		const entry = vaultEntry(file);
		if (!this.accepting && !isConflictFile(entry.path) && !isConflictFile(oldPath)) {
			if (entry.kind === 'file') this.startupEvents?.set(oldPath, 'delete').set(entry.path, 'upload');
			return;
		}
		this.engine()?.onFileRename(entry, oldPath);
	}
}
