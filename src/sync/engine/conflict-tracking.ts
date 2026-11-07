import { pendingChangeKey } from '../pending/pending-change';
import { isConflictFile } from '../conflict/conflict';
import type { ConflictStore } from '../conflict/store';
import type { LocalManifest } from '../manifest/manifest';
import type { SyncQueueController } from '../queue/controller';
import type { SyncApiClient } from '../worker-api/client';
import type { SyncIgnoreMatcher } from '../local/ignore';
import type { ConflictRecord } from '../types';
import { createLogger } from '../logger';
import { UNVERIFIED_MODIFIED } from '../transfer/applied-content';
import { errorMessage } from '../../platform/logger';

const logger = createLogger('SyncEngine');

interface ConflictTrackingContext {
	store: ConflictStore;
	api: Pick<SyncApiClient, 'getFileMetadata'>;
	manifest: Pick<LocalManifest, 'getEntry' | 'setEntry' | 'save'>;
	queue: Pick<SyncQueueController, 'restorePendingKeys'>;
	ignore: Pick<SyncIgnoreMatcher, 'configuredMatcher'>;
	trackWork: <T>(operation: () => Promise<T>) => Promise<T>;
	isDestroyed: () => boolean;
	throwIfDestroyed: () => void;
	updateConflictCount: (count: number) => void;
}

/** Keeps the conflict store in step with conflict copies in the vault: copies the user
 * creates, renames or deletes, recovery of copies the store lost, and review decisions. */
export class ConflictTracking {
	private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly context: ConflictTrackingContext) {}

	private readonly baselineRevision = (path: string): string | undefined => this.context.manifest.getEntry(path)?.revision;

	onFileChange(path: string): void {
		if (isConflictFile(path)) this.update(() => this.context.store.registerDiscovered(path), 'Failed to register conflict copy:');
	}

	onFileDelete(path: string): void {
		if (isConflictFile(path)) this.update(() => this.context.store.markResolved(path, this.baselineRevision), 'Failed to resolve conflict copy:');
	}

	onFileRename(path: string, oldPath: string): void {
		if (isConflictFile(oldPath)) {
			this.update(() => this.context.store.markResolved(oldPath, this.baselineRevision), 'Failed to resolve renamed conflict copy:');
		}
		if (isConflictFile(path)) this.update(() => this.context.store.registerDiscovered(path), 'Failed to register renamed conflict copy:');
	}

	/** Recovers copies the store does not list, once the vault has loaded. */
	scheduleRecovery(): void {
		if (this.context.isDestroyed() || this.recoveryTimer !== null) return;
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = null;
			this.recoverInBackground();
		}, 0);
	}

	async markResolved(path: string): Promise<void> {
		await this.context.store.markResolved(path);
		this.context.updateConflictCount(this.context.store.getActiveConflicts().length);
	}

	/** Preserve the user's keep-local intent without accepting a newer server edit.
	 * Publication remains in the ordinary durable upload/CAS pipeline. */
	async acceptIncomingBaseline(record: ConflictRecord): Promise<void> {
		if (record.copySide !== 'remote') return;
		const { api, manifest, queue, throwIfDestroyed } = this.context;
		throwIfDestroyed();
		const remote = (await api.getFileMetadata([record.originalPath])).files[record.originalPath];
		if (!record.remoteHash || !remote || remote.hash !== record.remoteHash) {
			throw new Error('The server file changed. Sync again and review the latest incoming copy. Both versions were kept.');
		}
		throwIfDestroyed();
		manifest.setEntry(record.originalPath, { ...remote, modified: UNVERIFIED_MODIFIED });
		await manifest.save();
		throwIfDestroyed();
		queue.restorePendingKeys([pendingChangeKey('upload', record.originalPath)]);
	}

	destroy(): void {
		if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = null;
	}

	private recoverInBackground(): void {
		if (this.context.isDestroyed()) return;
		const ignoreConfigured = this.context.ignore.configuredMatcher();
		void this.context.trackWork(() => this.context.store.recoverFromVault(
			ignoreConfigured,
			() => this.context.isDestroyed(),
			this.baselineRevision,
		)).catch((error) => {
			logger.warn('Conflict recovery failed:', errorMessage(error));
		});
	}

	private update(update: () => Promise<void>, failureMessage: string): void {
		void this.context.trackWork(update).catch((error) => {
			logger.warn(failureMessage, errorMessage(error));
		});
	}
}
