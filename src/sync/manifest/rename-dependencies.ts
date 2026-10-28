import type { Vault } from 'obsidian';
import type { LocalManifest } from './manifest';
import { readLocalFileEntry } from '../local/local-file-entry';
import { getSyncPathIssue } from '@/protocol/portable-path';
import { namespaceConflictLookup } from '../namespace-conflicts';
import { isRecord } from '@/platform/validation';

/** Baseline paths renamed since their last acknowledged upload, keyed by the old
 * path, with the path each now lives at. Deleting an old remote copy waits until
 * its destination is uploaded. */
export class RenameDependencies {
	private readonly dependencies: Map<string, string>;
	/** Current path -> baseline paths that now live there, so one file's rename
	 * updates only its own dependencies instead of scanning all of them. */
	private readonly targets = new Map<string, Set<string>>();

	constructor(dependencies: ReadonlyMap<string, string> = new Map()) {
		this.dependencies = new Map(dependencies);
		for (const [old, target] of this.dependencies) this.indexTarget(old, target);
	}

	/** Checkpoint order is insertion order. */
	get entries(): ReadonlyMap<string, string> { return this.dependencies; }

	destination(path: string): string | undefined { return this.dependencies.get(path); }

	toRecord(): Record<string, string> { return Object.fromEntries(this.dependencies); }

	set(old: string, target: string): void {
		// Updating in place keeps checkpoint key order unchanged.
		const previous = this.dependencies.get(old);
		if (previous !== undefined) this.unindexTarget(old, previous);
		this.dependencies.set(old, target);
		this.indexTarget(old, target);
	}

	delete(old: string): void {
		const target = this.dependencies.get(old);
		if (target === undefined) return;
		this.dependencies.delete(old);
		this.unindexTarget(old, target);
	}

	/** Follows a rename of `source` to `destination`. A folder move updates every
	 * dependency below it; a file move updates only those living at the file. Each
	 * of `sources` that moves without a dependency gains one. */
	recordRename(source: string, destination: string, folder: boolean, sources: readonly string[]): void {
		const move = (path: string) => path === source ? destination : path.startsWith(`${source}/`) ? destination + path.slice(source.length) : path;
		const affected = folder
			? [...this.dependencies].filter(([, target]) => move(target) !== target).map(([old]) => old)
			: [...this.targets.get(source) ?? []];
		for (const old of affected) {
			const next = move(this.dependencies.get(old)!);
			if (old === next) this.delete(old);
			else this.set(old, next);
		}
		for (const path of sources) {
			const target = move(path);
			if (target !== path && !this.dependencies.has(path)) this.set(path, target);
		}
	}

	private indexTarget(old: string, target: string): void {
		const olds = this.targets.get(target) ?? new Set<string>();
		olds.add(old);
		this.targets.set(target, olds);
	}

	private unindexTarget(old: string, target: string): void {
		const olds = this.targets.get(target);
		olds?.delete(old);
		if (olds?.size === 0) this.targets.delete(target);
	}
}

export function parseRenameDependencies(value: unknown): Map<string, string> {
	if (value === undefined) return new Map();
	if (!isRecord(value)) throw new Error('Invalid rename checkpoint. Preserve sync metadata before resetting.');
	for (const [source, destination] of Object.entries(value)) {
		if (getSyncPathIssue(source) || typeof destination !== 'string' || getSyncPathIssue(destination)) throw new Error('Invalid rename checkpoint. Preserve sync metadata before resetting.');
	}
	return new Map(Object.entries(value) as Array<[string, string]>);
}

export async function assertRenamePreserved(manifest: LocalManifest, vault: Vault, path: string): Promise<void> {
	if (manifest.uploadJournal.pending().length) throw new Error('Remote deletion deferred until pending uploads are resolved. The previous remote copies are preserved.');
	const destination = manifest.renameDestination(path);
	if (!destination) return;
	const local = await readLocalFileEntry(vault, destination);
	// The renamed copy was deleted or excluded locally, so nothing remains to
	// upload; deleting the old path is the user's intent.
	if (!local) return;
	// The server cannot store both names after a case-only or Unicode-only rename,
	// so the old copy must go first. File history retains it, and the renamed
	// local file stays queued for upload.
	if (namespaceConflictLookup([destination])(path) !== undefined) return;
	const saved = manifest.getEntry(destination);
	if (!saved?.revision || saved.hash !== local.hash) throw new Error(`Remote deletion deferred until the renamed file is uploaded: ${destination}`);
	// Persist the acknowledgement before the old copy can be deleted.
	await manifest.save();
}
