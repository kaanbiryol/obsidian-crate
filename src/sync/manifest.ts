import { CHECKPOINT_VERSION, parseCheckpoint, parseLocalManifest } from './manifest-checkpoint';
import { UploadJournal } from './upload-journal';
import { MAX_UPLOAD_DIAGNOSTICS, normalizeUploadDiagnostics, type UploadDiagnostic } from './upload-diagnostics';
/**
 * Local manifest management for tracking file state.
 * Stored in its own file (file-manifest.json) in the plugin directory,
 * separate from settings data to avoid write amplification.
 */

import type { App, PluginManifest } from 'obsidian';
import { createLogger } from '../plugin/logger';
import type { FileManifest, FileEntry } from '../protocol/sync-types';
import { createPathRecord, getPathEntry } from '../protocol/path-record';

const logger = createLogger('Manifest');

const MANIFEST_FILENAME = 'file-manifest.json';
const MANIFEST_TMP_FILENAME = 'file-manifest.json.tmp';

export class LocalManifest {
	readonly uploadJournal: UploadJournal;
	private renameDependencies = new Map<string, string>();
	private app: App;
	private manifestPath: string;
	private tmpPath: string;
	private manifest: FileManifest;
	private dirty: boolean;
	private revision = 0;
	private generation = 0;
	private saveChain: Promise<void> = Promise.resolve();
	private loadTask: Promise<void> = Promise.resolve();
	private closed = false;
	private uploadDiagnostics: UploadDiagnostic[] = [];

	constructor(app: App, pluginManifest: PluginManifest, private readonly authority?: string) {
		this.app = app;
		this.uploadJournal = new UploadJournal(app.vault.adapter, `${pluginManifest.dir}/pending-uploads`, authority);
		this.manifestPath = `${pluginManifest.dir}/${MANIFEST_FILENAME}`;
		this.tmpPath = `${pluginManifest.dir}/${MANIFEST_TMP_FILENAME}`;
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
			&& (JSON.stringify(main.manifest) !== JSON.stringify(tmp.manifest)
				|| JSON.stringify(main.settledUploads) !== JSON.stringify(tmp.settledUploads)
				|| JSON.stringify([...main.renames]) !== JSON.stringify([...tmp.renames])))) {
			throw new Error('Conflicting manifest checkpoints. Preserve both generations before recovering sync.');
		}
		const recoverTmp = tmp && (!main || tmp.generation > main.generation);
		const selected = recoverTmp ? tmp : main;
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
			this.renameDependencies = selected.renames;
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
	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([this.loadTask, this.saveChain, this.uploadJournal.close()]);
	}

	private serialize(): string {
		return JSON.stringify({ ...this.manifest, version: CHECKPOINT_VERSION, ...(this.uploadDiagnostics.length ? { uploadDiagnostics: this.uploadDiagnostics } : {}), ...(this.uploadJournal.completedSnapshot().length ? { settledUploads: this.uploadJournal.completedSnapshot() } : {}), ...(this.renameDependencies.size ? { renameDependencies: Object.fromEntries(this.renameDependencies) } : {}), generation: this.generation, ...(this.authority === undefined ? {} : { authority: this.authority }) });
	}

	private async persist(): Promise<void> {
		const adapter = this.app.vault.adapter;
		while (this.dirty && !this.closed) {
			const revision = this.revision;
			this.generation++;
			const data = this.serialize();
			await adapter.write(this.tmpPath, data);
			if (this.closed) return;
			await adapter.write(this.manifestPath, data);
			if (this.closed) return;
			try { await adapter.remove(this.tmpPath); } catch { /* best effort */ }
			this.dirty = revision !== this.revision;
		}
	}

	/**
	 * Get file entry
	 */
	getEntry(path: string): FileEntry | undefined {
		return getPathEntry(this.manifest.files, path);
	}

	/**
	 * Set file entry
	 */
	setEntry(path: string, entry: FileEntry): void {
		const previous = this.getEntry(path);
		this.manifest.files[path] = { ...entry, revision: entry.revision ?? (previous?.hash === entry.hash ? previous.revision : undefined) };
		this.revision++;
		this.dirty = true;
	}

	/**
	 * Remove file entry
	 */
	removeEntry(path: string): void {
		this.renameDependencies.delete(path);
		delete this.manifest.files[path];
		this.revision++;
		this.dirty = true;
	}

	completeUpload(id: string): void {
		this.uploadJournal.complete(id);
		this.revision++;
		this.dirty = true;
	}

	getUploadDiagnostics(): UploadDiagnostic[] { return this.uploadDiagnostics.map(row => ({ ...row })); }

	recordUploadDiagnostic(input: Omit<UploadDiagnostic, 'at' | 'generation'> & { at?: string }): void {
		const [row] = normalizeUploadDiagnostics([{ ...input, at: input.at ?? new Date().toISOString(), generation: this.generation + 1 }]);
		if (!row) return;
		this.uploadDiagnostics.push(row);
		this.uploadDiagnostics = this.uploadDiagnostics.slice(-MAX_UPLOAD_DIAGNOSTICS);
		this.revision++;
		this.dirty = true;
	}

	renameDestination(path: string): string | undefined { return this.renameDependencies.get(path); }

	recordRename(source: string, destination: string): void {
		const move = (path: string) => path === source ? destination : path.startsWith(`${source}/`) ? destination + path.slice(source.length) : path;
		for (const [old, target] of this.renameDependencies) this.renameDependencies.set(old, move(target));
		for (const path of this.getAllPaths()) {
			const target = move(path);
			if (target !== path) this.renameDependencies.set(path, target);
		}
		this.revision++;
		this.dirty = true;
	}

	/**
	 * Get all file paths
	 */
	getAllPaths(): string[] {
		return Object.keys(this.manifest.files);
	}

	/**
	 * Get full manifest
	 */
	getManifest(): FileManifest {
		return this.manifest;
	}

	/**
	 * Replace entire manifest (used after remote sync)
	 */
	replaceManifest(manifest: FileManifest): void {
		this.manifest = parseLocalManifest(manifest);
		this.revision++;
		this.dirty = true;
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
		this.revision++;
		this.dirty = true;
	}
}
