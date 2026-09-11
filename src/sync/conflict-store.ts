import type { App, PluginManifest } from 'obsidian';
import { isRecord } from '../plugin/settings';
import type { ConflictRecord } from './types';
import { createLogger, errorMessage } from '../plugin/logger';
import { getOriginalPathFromConflictFile, isConflictFile } from './conflict';
import { getAllVaultFiles } from './file-discovery';

const logger = createLogger('ConflictStore');
const STORE_FILENAME = 'conflicts.json';
const STORE_TMP_FILENAME = 'conflicts.json.tmp';
const MAX_RESOLVED_CONFLICTS = 200;

interface ConflictStoreData {
	version: 1;
	conflicts: ConflictRecord[];
}

export interface RecordConflictInput {
	copySide?: 'local' | 'remote';
	originalPath: string;
	conflictPath: string;
	cause: Exclude<ConflictRecord['cause'], 'unknown'>;
	localHash: string;
	remoteHash: string;
	baseHash?: string;
}

export class ConflictStore {
	private readonly storePath: string;
	private readonly tmpPath: string;
	private data: ConflictStoreData = { version: 1, conflicts: [] };
	private dirty = false;
	private mutationChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly app: App,
		pluginManifest: PluginManifest,
		private readonly onActiveCountChange?: (count: number) => void,
	) {
		this.storePath = `${pluginManifest.dir}/${STORE_FILENAME}`;
		this.tmpPath = `${pluginManifest.dir}/${STORE_TMP_FILENAME}`;
	}

	load(): Promise<void> {
		return this.enqueueMutation(() => this.loadFromDisk());
	}

	private async loadFromDisk(): Promise<void> {
		const adapter = this.app.vault.adapter;
		let loaded = false;
		let recoveredFromTmp = false;
		for (const path of [this.storePath, this.tmpPath]) {
			if (loaded || !await adapter.exists(path)) continue;
			try {
				const parsed = normalizeStore(JSON.parse(await adapter.read(path)));
				if (parsed) {
					this.data = parsed;
					loaded = true;
					recoveredFromTmp = path === this.tmpPath;
				}
			} catch (error) {
				logger.warn(`Failed to read conflict store ${path}:`, errorMessage(error));
			}
		}

		if (recoveredFromTmp) {
			this.dirty = true;
			await this.save();
		} else if (await adapter.exists(this.tmpPath)) {
			try {
				await adapter.remove(this.tmpPath);
			} catch {
				// Best effort cleanup of a stale temp file.
			}
		}
		this.notifyCountChanged();
	}

	async recoverFromVault(
		shouldIgnore: (path: string) => boolean,
		isCancelled: () => boolean = () => false,
	): Promise<void> {
		if (isCancelled()) return;

		let discoveredPaths: Set<string>;
		try {
			const files = await getAllVaultFiles(
				this.app.vault,
				(path) => this.isStorePath(path) || shouldIgnore(path),
			);
			discoveredPaths = new Set(files.map((file) => file.path).filter(isConflictFile));
		} catch (error) {
			logger.warn('Failed to discover conflict copies:', errorMessage(error));
			return;
		}

		if (isCancelled()) return;
		await this.enqueueMutation(async () => {
			if (isCancelled()) return;
			let changed = false;

			for (const conflictPath of discoveredPaths) {
				if (!this.data.conflicts.some((conflict) => conflict.conflictPath === conflictPath)) {
					this.data.conflicts.push({
						originalPath: getOriginalPathFromConflictFile(conflictPath) ?? conflictPath,
						conflictPath,
						createdAt: new Date().toISOString(),
						cause: 'unknown',
						...(conflictPath.includes('(conflict remote ') ? { copySide: 'remote' as const } : {}),
						status: 'active',
					});
					this.dirty = true;
					changed = true;
				}
			}

			for (const conflict of this.data.conflicts) {
				if (conflict.status !== 'active' || discoveredPaths.has(conflict.conflictPath)) continue;
				try {
					if (!await this.app.vault.adapter.exists(conflict.conflictPath)) {
						conflict.status = 'resolved';
						this.dirty = true;
						changed = true;
					}
				} catch {
					// A transient adapter failure must not resolve a conflict.
				}
			}

			await this.save();
			if (changed) this.notifyCountChanged();
		});
	}

	getActiveConflicts(): ConflictRecord[] {
		return this.data.conflicts
			.filter((conflict) => conflict.status === 'active')
			.map((conflict) => ({ ...conflict }))
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	record(input: RecordConflictInput): Promise<void> {
		return this.enqueueMutation(async () => {
			const existing = this.data.conflicts.find((conflict) => conflict.conflictPath === input.conflictPath);
			const record: ConflictRecord = {
				...input,
				createdAt: existing?.createdAt ?? new Date().toISOString(),
				status: 'active',
			};
			if (existing) Object.assign(existing, record);
			else this.data.conflicts.push(record);
			this.dirty = true;
			await this.save();
			this.notifyCountChanged();
		});
	}

	markResolved(conflictPath: string): Promise<void> {
		return this.enqueueMutation(async () => {
			const existing = this.data.conflicts.find((conflict) => conflict.conflictPath === conflictPath);
			if (!existing || existing.status === 'resolved') return;
			existing.status = 'resolved';
			this.dirty = true;
			await this.save();
			this.notifyCountChanged();
		});
	}

	registerDiscovered(conflictPath: string): Promise<void> {
		return this.enqueueMutation(async () => {
			if (!isConflictFile(conflictPath)) return;
			const existing = this.data.conflicts.find((conflict) => conflict.conflictPath === conflictPath);
			if (existing) {
				if (existing.status === 'resolved') {
					existing.status = 'active';
					this.dirty = true;
					await this.save();
					this.notifyCountChanged();
				}
				return;
			}

			this.data.conflicts.push({
				originalPath: getOriginalPathFromConflictFile(conflictPath) ?? conflictPath,
				conflictPath,
				createdAt: new Date().toISOString(),
				cause: 'unknown',
				status: 'active',
			});
			this.dirty = true;
			await this.save();
			this.notifyCountChanged();
		});
	}

	private isStorePath(path: string): boolean {
		const storeDir = this.storePath.substring(0, this.storePath.lastIndexOf('/'));
		return path === this.storePath
			|| path === this.tmpPath
			|| path === storeDir
			|| path.startsWith(`${storeDir}/`);
	}

	private async save(): Promise<void> {
		if (!this.dirty) return;
		this.data.conflicts = pruneConflictRecords(this.data.conflicts);
		const adapter = this.app.vault.adapter;
		const serialized = JSON.stringify(this.data);
		await adapter.write(this.tmpPath, serialized);
		await adapter.write(this.storePath, serialized);
		try {
			await adapter.remove(this.tmpPath);
		} catch {
			// The next load will clean up a leftover temp file.
		}
		this.dirty = false;
	}

	private notifyCountChanged(): void {
		this.onActiveCountChange?.(this.getActiveConflicts().length);
	}

	private enqueueMutation(task: () => Promise<void>): Promise<void> {
		const next = this.mutationChain.then(task, task);
		this.mutationChain = next.catch(() => {});
		return next;
	}
}

function normalizeStore(value: unknown): ConflictStoreData | null {
	if (!isRecord(value) || !Array.isArray(value.conflicts)) return null;
	const normalized = value.conflicts
		.map(normalizeConflictRecord)
		.filter((record): record is ConflictRecord => record !== null);
	const conflictsByPath = new Map<string, ConflictRecord>();
	for (const conflict of normalized) {
		const existing = conflictsByPath.get(conflict.conflictPath);
		if (
			!existing
			|| (existing.status === 'resolved' && conflict.status === 'active')
			|| (existing.status === conflict.status && conflict.createdAt > existing.createdAt)
		) {
			conflictsByPath.set(conflict.conflictPath, conflict);
		}
	}
	return { version: 1, conflicts: pruneConflictRecords([...conflictsByPath.values()]) };
}

function pruneConflictRecords(conflicts: ConflictRecord[]): ConflictRecord[] {
	const active = conflicts.filter((conflict) => conflict.status === 'active');
	const resolved = conflicts
		.filter((conflict) => conflict.status === 'resolved')
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
		.slice(0, MAX_RESOLVED_CONFLICTS);
	return [...active, ...resolved];
}

function normalizeConflictRecord(value: unknown): ConflictRecord | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.originalPath !== 'string'
		|| typeof value.conflictPath !== 'string'
		|| typeof value.createdAt !== 'string'
		|| (value.status !== 'active' && value.status !== 'resolved')
		|| (value.cause !== 'concurrent-create' && value.cause !== 'concurrent-edit' && value.cause !== 'incoming-review' && value.cause !== 'unknown')
	) {
		return null;
	}
	return {
		originalPath: value.originalPath,
		conflictPath: value.conflictPath,
		createdAt: value.createdAt,
		cause: value.cause,
		status: value.status,
		...(typeof value.localHash === 'string' ? { localHash: value.localHash } : {}),
		...(value.copySide === 'remote' ? { copySide: 'remote' as const } : {}),
		...(typeof value.remoteHash === 'string' ? { remoteHash: value.remoteHash } : {}),
		...(typeof value.baseHash === 'string' ? { baseHash: value.baseHash } : {}),
	};
}
