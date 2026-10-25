import { encodeCheckpoint, parseCheckpoint, parseLocalManifest, sameCheckpointRecoveryState } from './manifest-checkpoint';
import { encodeLogHeader, encodeLogRecord, encodeLogState, replayManifestLog, type EncodedLogState } from './manifest-log';
import { UploadJournal } from '../durability/upload-journal';
import { parseRestoreIntents, type RestoreIntent } from '../durability/restore-intent';
import { parseInitialConfigPull, type InitialConfigPull } from '../planner/initial-config-pull';
import { MAX_UPLOAD_DIAGNOSTICS, normalizeUploadDiagnostics, type UploadDiagnostic } from '../diagnostics/upload-diagnostics';
/**
 * Local manifest management for tracking file state.
 * Stored in its own file (file-manifest.json) in the plugin directory,
 * separate from settings data to avoid write amplification.
 */

import type { App, PluginManifest } from 'obsidian';
import { createLogger } from '../logger';
import type { FileManifest, FileEntry } from '../../protocol/sync-types';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';

import { syncStoragePaths } from './storage-paths';
import { RenameDependencies } from './rename-dependencies';

const logger = createLogger('Manifest');

// Compact into a full checkpoint once replaying the log costs about as much as
// a small rewrite; the log also caps the work of the next load.
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** Live baseline view. Only the owner may replace entries and mark them dirty. */
export type LocalManifestView = Readonly<Omit<FileManifest, 'files'>> & {
	readonly files: Readonly<Record<string, Readonly<FileEntry>>>;
};

export class LocalManifest {
	readonly uploadJournal: UploadJournal;
	private renames = new RenameDependencies();
	private appliedRename?: string;
	private app: App;
	private manifestPath: string;
	private tmpPath: string;
	private logPath: string;
	/** Paths whose entries changed since the last persisted checkpoint or log record. */
	private changedPaths = new Set<string>();
	/** The log on disk extends the current base checkpoint; otherwise the next save compacts. */
	private logActive = false;
	private logBytes = 0;
	/** Recovery state as of the checkpoint plus log on disk; records write only differences. */
	private persistedState?: EncodedLogState;
	private manifest: FileManifest;
	private dirty: boolean;
	private revision = 0;
	private generation = 0;
	private saveChain: Promise<void> = Promise.resolve();
	private loadTask: Promise<void> = Promise.resolve();
	private closed = false;
	private uploadDiagnostics: UploadDiagnostic[] = [];
	private restoreIntents: RestoreIntent[] = [];
	private initialConfigPull?: InitialConfigPull;
	// Random server names of encrypted notes learned before their entry is written.
	private pendingWires = new Map<string, string>();

	constructor(app: App, pluginManifest: PluginManifest, private readonly authority?: string) {
		this.app = app;
		const paths = syncStoragePaths(pluginManifest.dir!);
		this.uploadJournal = new UploadJournal(app.vault.adapter, paths.uploadJournal, authority);
		this.manifestPath = paths.manifest;
		this.tmpPath = paths.manifestTmp;
		this.logPath = paths.manifestLog;
		this.manifest = { version: 1, files: createPathRecord() };
		this.dirty = false;
	}

	/**
	 * Load manifest from its dedicated file.
	 * Select the newest valid main or temporary generation after a crash.
	 */
	load(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.loadTask = this.readCheckpoint();
		return this.loadTask;
	}

	private async readCheckpoint(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const read = async (path: string) => {
			if (!await adapter.exists(path)) return null;
			// An I/O error is not an absent checkpoint. Only torn JSON may recover
			// from the other generation; unknown or semantically damaged data stops.
			const bytes = await adapter.read(path);
			let parsed: unknown;
			try { parsed = JSON.parse(bytes); }
			catch { return { torn: bytes } as const; }
			return parseCheckpoint(parsed);
		};
		const mainRead = await read(this.manifestPath);
		const tmpRead = await read(this.tmpPath);
		const main = mainRead && !('torn' in mainRead) ? mainRead : null;
		const tmp = tmpRead && !('torn' in tmpRead) ? tmpRead : null;
		if (this.closed) return;
		for (const checkpoint of [main, tmp]) {
			if (checkpoint && this.authority !== undefined && checkpoint.authority !== this.authority) {
				throw new Error('Sync checkpoint is not bound to this server. Disconnect and reconnect before syncing; local files and the previous checkpoint are preserved.');
			}
		}
		if (main && tmp && (main.authority !== tmp.authority || main.generation === tmp.generation
			&& !sameCheckpointRecoveryState(main, tmp))) {
			throw new Error('Conflicting manifest checkpoints. Preserve both generations before recovering sync.');
		}
		const recoverTmp = tmp && (!main || tmp.generation > main.generation);
		const selected = recoverTmp ? tmp : main;
		if (selected && !recoverTmp && await adapter.exists(this.logPath)) {
			const log = await adapter.read(this.logPath);
			if (this.closed) return;
			// A recovered tmp postdates any log, so only the main checkpoint extends one.
			this.logActive = replayManifestLog(selected, log)?.appendable ?? false;
			this.logBytes = this.logActive ? log.length : 0;
		}
		if (!selected && (await adapter.exists(this.manifestPath) || await adapter.exists(this.tmpPath))) {
			throw new Error('Invalid manifest checkpoint. Preserve this vault and its metadata before resetting sync.');
		}
		if (selected) {
			// Preserve a torn generation before promotion or later checkpoint writes.
			for (const [path, checkpoint] of [[this.manifestPath, mainRead], [this.tmpPath, tmpRead]] as const) {
				if (checkpoint && 'torn' in checkpoint) await adapter.write(`${path}.corrupt-${crypto.randomUUID()}`, checkpoint.torn);
			}
			this.manifest = selected.manifest;
			this.uploadDiagnostics = selected.uploadDiagnostics;
			this.restoreIntents = selected.restoreIntents;
			this.initialConfigPull = selected.initialConfigPull;
			this.renames = new RenameDependencies(selected.renames);
			this.appliedRename = selected.appliedRename;
			this.persistedState = encodeLogState(selected);
			await this.uploadJournal.load(selected.settledUploads ?? []);
			if (this.closed) return;
			this.generation = selected.generation;
			if (recoverTmp) {
				// Leave tmp intact if promotion fails, so the next load can retry.
				await adapter.write(this.manifestPath, this.serialize());
				logger.info('Recovered newer manifest checkpoint');
			}
		} else {
			await this.uploadJournal.load();
		}
		if (this.closed) return;
		if (await adapter.exists(this.tmpPath)) {
			try { await adapter.remove(this.tmpPath); } catch { /* best effort */ }
		}
		logger.info(`Manifest loaded with ${this.getFileCount()} files`);
	}

	/** Serialize checkpoints and include changes made while disk writes await. */
	save(): Promise<void> {
		if (this.closed) return Promise.resolve();
		const save = this.saveChain.catch(() => {}).then(async () => {
			const completed = this.uploadJournal.completedSnapshot();
			for (const id of completed) {
				const prior = [...this.uploadDiagnostics].reverse().find(row => row.operationId === id);
				if (prior && prior.phase !== 'checkpointed') this.recordUploadDiagnostic({ ...prior, at: undefined, phase: 'checkpointed' });
			}
			await this.persist();
			if (!this.closed) await this.uploadJournal.pruneCompleted(completed);
		});
		this.saveChain = save;
		return save;
	}

	/** Fence late callbacks and wait for every checkpoint I/O before reset/reuse. */
	/** Waits for the initial load and queued saves without closing the manifest. */
	async whenSaved(): Promise<void> {
		await Promise.allSettled([this.loadTask, this.saveChain]);
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([this.loadTask, this.saveChain, this.uploadJournal.close()]);
	}

	private serialize(): string {
		return encodeCheckpoint({
			manifest: this.manifest,
			generation: this.generation,
			authority: this.authority,
			settledUploads: this.uploadJournal.completedSnapshot(),
			renames: this.renames.entries,
			appliedRename: this.appliedRename,
			uploadDiagnostics: this.uploadDiagnostics,
			restoreIntents: this.restoreIntents,
			initialConfigPull: this.initialConfigPull,
		});
	}

	private async persist(): Promise<void> {
		while (this.dirty && !this.closed) {
			const revision = this.revision;
			const changed = this.changedPaths;
			this.changedPaths = new Set();
			try {
				if (!await this.appendChanges(changed)) await this.compact();
			} catch (error) {
				for (const path of changed) this.changedPaths.add(path);
				throw error;
			}
			if (this.closed) return;
			this.dirty = revision !== this.revision;
		}
	}

	/** Append one record when the active log has room; false requests compaction. */
	private async appendChanges(changed: ReadonlySet<string>): Promise<boolean> {
		if (!this.logActive) return false;
		const set = createPathRecord<FileEntry>();
		const deleted: string[] = [];
		for (const path of changed) {
			const entry = getPathEntry(this.manifest.files, path);
			if (entry) set[path] = entry;
			else deleted.push(path);
		}
		const state = encodeLogState(this.recoveryState());
		const record = encodeLogRecord({ generation: this.generation + 1, set, deleted, state, previous: this.persistedState });
		if (this.logBytes + record.length > MAX_LOG_BYTES) return false;
		// The first record after a compaction replaces any older log with its header.
		if (this.logBytes === 0) {
			const header = encodeLogHeader(this.generation, this.authority);
			await this.app.vault.adapter.write(this.logPath, header + record);
			this.logBytes = header.length;
		} else await this.app.vault.adapter.append(this.logPath, record);
		this.generation++;
		this.logBytes += record.length;
		this.persistedState = state;
		return true;
	}

	/** Write a full checkpoint, then start a new log bound to its generation. */
	private async compact(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.logActive = false;
		this.generation++;
		const state = encodeLogState(this.recoveryState());
		const data = this.serialize();
		await adapter.write(this.tmpPath, data);
		if (this.closed) return;
		await adapter.write(this.manifestPath, data);
		if (this.closed) return;
		try { await adapter.remove(this.tmpPath); } catch { /* best effort */ }
		// A stale log stays until the next record replaces it; its header names an
		// older base, so loading ignores it.
		this.logBytes = 0;
		this.persistedState = state;
		this.logActive = true;
	}

	private recoveryState() {
		return {
			settledUploads: this.uploadJournal.completedSnapshot(),
			renames: this.renames.entries,
			appliedRename: this.appliedRename,
			uploadDiagnostics: this.uploadDiagnostics,
			restoreIntents: this.restoreIntents,
			initialConfigPull: this.initialConfigPull,
		};
	}

	/** Preserve entry identity so readers can detect replacement across awaited I/O. */
	getEntry(path: string): Readonly<FileEntry> | undefined {
		return getPathEntry(this.manifest.files, path);
	}

	/**
	 * Set file entry
	 */
	setEntry(path: string, entry: Readonly<FileEntry>): void {
		const previous = this.getEntry(path);
		// A note keeps its random server name until it is deleted or renamed.
		const wire = entry.wire ?? previous?.wire ?? this.pendingWires.get(path);
		this.pendingWires.delete(path);
		this.manifest.files[path] = { ...entry, revision: entry.revision ?? (previous?.hash === entry.hash ? previous.revision : undefined), ...(wire ? { wire } : {}) };
		this.changedPaths.add(path);
		this.markChanged();
	}

	/** The server path of an encrypted note whose server name is random, if known. */
	wireOf(path: string): string | undefined {
		return this.getEntry(path)?.wire ?? this.pendingWires.get(path);
	}

	pathOfWire(wire: string): string | undefined {
		for (const [path, entry] of Object.entries(this.manifest.files)) if (entry.wire === wire) return path;
		for (const [path, pending] of this.pendingWires) if (pending === wire) return path;
		return undefined;
	}

	noteWire(path: string, wire: string): void {
		const entry = this.getEntry(path);
		if (!entry) { this.pendingWires.set(path, wire); return; }
		if (entry.wire === wire) return;
		this.manifest.files[path] = { ...entry, wire };
		this.changedPaths.add(path);
		this.markChanged();
	}

	/**
	 * Remove file entry
	 */
	removeEntry(path: string): void {
		this.renames.delete(path);
		this.pendingWires.delete(path);
		delete this.manifest.files[path];
		this.changedPaths.add(path);
		this.markChanged();
	}

	completeUpload(id: string): void {
		this.uploadJournal.complete(id);
		this.markChanged();
	}

	/** Every mutation advances the revision, so a save in progress writes it next. */
	private markChanged(): void {
		this.revision++;
		this.dirty = true;
	}

	getRestoreIntents(): RestoreIntent[] { return structuredClone(this.restoreIntents); }

	getInitialConfigPull(): InitialConfigPull | undefined { return structuredClone(this.initialConfigPull); }

	setInitialConfigPull(state: InitialConfigPull | undefined): void {
		this.initialConfigPull = parseInitialConfigPull(state);
		this.markChanged();
	}

	setRestoreIntent(intent: RestoreIntent): void {
		this.restoreIntents = parseRestoreIntents([...this.restoreIntents.filter(item => item.request.storageKey !== intent.request.storageKey), intent]);
		this.markChanged();
	}

	removeRestoreIntent(storageKey: string): void {
		this.restoreIntents = this.restoreIntents.filter(item => item.request.storageKey !== storageKey);
		this.markChanged();
	}

	getUploadDiagnostics(): UploadDiagnostic[] { return this.uploadDiagnostics.map(row => ({ ...row })); }

	recordUploadDiagnostic(input: Omit<UploadDiagnostic, 'at' | 'generation'> & { at?: string }): void {
		const [row] = normalizeUploadDiagnostics([{ ...input, at: input.at ?? new Date().toISOString(), generation: this.generation + 1 }]);
		if (!row) return;
		this.uploadDiagnostics.push(row);
		this.uploadDiagnostics = this.uploadDiagnostics.slice(-MAX_UPLOAD_DIAGNOSTICS);
		this.markChanged();
	}

	renameDestination(path: string): string | undefined { return this.renames.destination(path); }
	getRenameDependencies(): Record<string, string> { return this.renames.toRecord(); }

	/**
	 * Obsidian reports a folder move as one event for the folder plus one per
	 * file. A file moves alone, so only folder events (or callers that cannot
	 * tell, for an untracked source) scan every path below the source.
	 */
	recordRename(source: string, destination: string, kind?: 'file' | 'folder'): void {
		const tracked = Boolean(getPathEntry(this.manifest.files, source));
		const folder = kind ? kind === 'folder' : !tracked;
		this.renames.recordRename(source, destination, folder, folder ? this.getAllPaths() : tracked ? [source] : []);
		this.markChanged();
	}

	/**
	 * Get all file paths
	 */
	getAllPaths(): string[] {
		return Object.keys(this.manifest.files);
	}

	/** Return the live baseline without permitting writes around revision tracking. */
	getManifest(): LocalManifestView {
		return this.manifest;
	}

	/**
	 * Replace entire manifest (used after remote sync)
	 */
	replaceManifest(manifest: LocalManifestView): void {
		this.manifest = parseLocalManifest(manifest);
		this.logActive = false;
		this.markChanged();
	}

	/**
	 * Check if file exists in manifest
	 */
	hasFile(path: string): boolean {
		return this.getEntry(path) !== undefined;
	}

	/**
	 * Check if file hash matches
	 */
	hashMatches(path: string, hash: string): boolean {
		const entry = this.getEntry(path);
		return entry?.hash === hash;
	}

	/**
	 * Get file count
	 */
	getFileCount(): number {
		return Object.keys(this.manifest.files).length;
	}

	/**
	 * Clear manifest
	 */
	clear(): void {
		this.manifest = { version: 1, files: createPathRecord() };
		this.logActive = false;
		this.markChanged();
	}
}
