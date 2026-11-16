import type { Vault } from 'obsidian';
import { pendingChangeKey, type PendingKey } from '../pending/pending-change';
import { findStartupPendingPaths } from '../pending/startup-pending';
import { verifyUnchangedPendingPaths } from '../pending/pending-verification';
import { hasLocalFileChanges } from '../local/local-file-changes';
import type { VaultFile } from '../local/file-discovery';
import type { LocalManifest } from '../manifest/manifest';
import { PREPARE_CONCURRENCY } from '../transfer/constants';
import { isAbortError } from '../abort';
import { syncErrorIssues } from '../issues';
import { errorMessage } from '../../platform/logger';
import type { SyncSettings } from '../settings';
import type { SyncState } from '../types';
import { LocalContentVerifier } from './content-verifier';
import type { SyncEngineLifecycle } from './lifecycle';

interface LocalChangeDependencies {
	vault: Vault;
	manifest: LocalManifest;
	/** Where content verification keeps the hashes it already checked, and the server they belong to. */
	verification: { path: string; authority: string };
	shouldIgnore: (path: string) => boolean;
	getSettings: () => SyncSettings;
	getState: () => SyncState;
	updateState: (updates: Partial<SyncState>) => void;
	apiConfigured: () => boolean;
	hasPendingRestores: () => boolean;
	restorePendingKeys: (keys: PendingKey[]) => void;
	/** A check stays current until sync activity starts. */
	captureSyncActivity: () => () => boolean;
	trackWork: <T>(operation: () => Promise<T>) => Promise<T>;
	lifecycle: Pick<SyncEngineLifecycle, 'abortSignal' | 'runConcurrent'>;
}

/** Finds local edits that fired no vault event: the startup scan while automatic sync is
 * off, same-metadata edits found by content checks, and verification that pending paths
 * are still unchanged before the queue settles them. */
export class LocalChangeDetection {
	private readonly contentVerifier: LocalContentVerifier;
	/** The patterns the pending list was last built with; settings objects are updated in place. */
	private scanPatterns: readonly string[];

	constructor(private readonly d: LocalChangeDependencies) {
		this.contentVerifier = new LocalContentVerifier({ adapter: d.vault.adapter, ...d.verification });
		this.scanPatterns = [...d.getSettings().ignorePatterns];
	}

	/** Records the current exclusions and reports whether one the pending list used was removed. */
	exclusionRemoved(patterns: readonly string[]): boolean {
		const removed = this.scanPatterns.some(pattern => !patterns.includes(pattern));
		this.scanPatterns = [...patterns];
		return removed;
	}

	verifyContent(files: VaultFile[]): Promise<boolean> {
		return this.d.trackWork(() => this.contentVerifier.verify(this.d.vault, this.d.manifest, files, this.d.lifecycle.abortSignal));
	}

	hasUnsyncedChanges(): Promise<boolean> {
		return this.d.trackWork(() => hasLocalFileChanges(
			this.d.vault,
			this.d.manifest,
			this.d.shouldIgnore,
			files => this.verifyContent(files),
			() => this.d.lifecycle.abortSignal.throwIfAborted(),
		));
	}

	/** While automatic sync is off, surface same-metadata edits as pending changes. */
	async verifyTracked(): Promise<void> {
		const state = this.d.getState();
		if (state.status === 'syncing' || state.initializing || !this.d.apiConfigured()) return;
		const activityCurrent = this.d.captureSyncActivity();
		await this.d.trackWork(async () => {
			const changed = await this.contentVerifier.verifyTracked(this.d.vault, this.d.manifest, this.d.shouldIgnore, this.d.lifecycle.abortSignal);
			if (changed.length && activityCurrent() && !this.d.getSettings().automaticSync) {
				this.d.restorePendingKeys(changed.map(path => pendingChangeKey('upload', path)));
			}
		});
	}

	verifyPendingPaths(keys: string[], isCurrent: (key: string) => boolean, replayed?: ReadonlySet<string>): Promise<string[]> {
		const activityCurrent = this.d.captureSyncActivity();
		return verifyUnchangedPendingPaths({
			adapter: this.d.vault.adapter,
			manifest: this.d.manifest,
			replayed,
			isCurrent: key => isCurrent(key) && activityCurrent()
				&& this.d.manifest.uploadJournal.pending().length === 0
				&& !this.d.hasPendingRestores(),
		}, keys);
	}

	/** Lists local changes made while Obsidian was closed, as the queue would have recorded them. */
	restorePending(): void {
		if (this.d.lifecycle.abortSignal.aborted) return;
		if (this.d.getState().status === 'syncing') {
			this.d.updateState({ initializing: false });
			return;
		}
		const activityCurrent = this.d.captureSyncActivity();
		void this.d.trackWork(async () => {
			try {
				const paths = await findStartupPendingPaths({
					vault: this.d.vault,
					baseline: this.d.manifest.getManifest().files,
					shouldIgnore: this.d.shouldIgnore,
					signal: this.d.lifecycle.abortSignal,
					verifyContent: files => this.verifyContent(files),
					runConcurrent: (tasks, concurrency) => this.d.lifecycle.runConcurrent(tasks, concurrency),
				}, PREPARE_CONCURRENCY);
				if (activityCurrent() && !this.d.getSettings().automaticSync) {
					this.d.restorePendingKeys(paths);
				}
			} catch (error) {
				if (!isAbortError(error) && activityCurrent()) {
					this.d.updateState({ status: 'error', lastError: `Could not check local changes: ${errorMessage(error)}`, lastIssues: syncErrorIssues(error) });
				}
			} finally {
				this.d.updateState({ initializing: false });
			}
		});
	}
}
