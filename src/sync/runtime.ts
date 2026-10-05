import type { ConnectionTestResult } from './types';
import { createRuntimeHistoryRestore, loadRuntimeHistoryComparison } from './runtime-history-workflow';
import type { SharedCheckpoint } from '../protocol/history-checkpoints';
import { loadFileHistoryPreview, loadCurrentSyncedPreview } from './file-history-preview';
import type { CrateServerInfo } from '../protocol';
import { createConflictReview } from './conflict-review';
import type { SyncActivityProgress } from './types';
import type { Plugin, TAbstractFile } from 'obsidian';
import { createLogger, errorMessage } from '../plugin/logger';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import { loadEncryptionKeys, saveEncryptionKeys } from '../plugin/encryption-storage';
import { runEncryptionReset } from './runtime-encryption-reset-workflow';
import { changeEncryptedServerAddress, changeEncryptionResetAddress } from './runtime-address-workflow';
import type { EncryptionServerState } from '../encryption/server-state';
import type { ConflictRecord, SyncHistoryEntry, SyncResult, SyncState } from './types';
import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';
import { SyncApiClient } from './api';
import { isConflictFile, notifyConflicts } from './conflict';
import { SyncEngine } from './engine';
import { normalizeWorkerUrl, requireNormalizedWorkerUrl } from './worker-url';
import { buildDiagnosticExport } from './diagnostic-export';
import {
	applyInfrastructureConfigState,
	buildSharedSettings,
	clearSyncConfigurationState,
	deleteManifestFile,
	type ApplyInfrastructureConfigInput,
} from './runtime-config';
import { recordSyncHistory, resetStoredSyncState } from './runtime-history';
import { emitStateChange, emitSyncProgress } from './runtime-listeners';
import { createSyncFailureResult, SYNC_ERROR_MESSAGES } from './sync-result';
import { RuntimeServerStatus } from './runtime-server-status';

const logger = createLogger('SyncRuntime');
export const FOREGROUND_SYNC_DEBOUNCE_MS = 1_000;
export const FOREGROUND_SYNC_COOLDOWN_MS = 30_000;

export type ForegroundSyncReason = 'focus' | 'visible' | 'online';

/** Transition authority stays with the runtime across stopping and initialization. */
export interface RuntimeConfigurationTransition {
	verify: () => void;
	stop: () => void;
	waitForIdle: () => Promise<void>;
	initialize: (resumeEncryptionReset?: boolean) => Promise<void>;
}

export class SyncRuntime {
	private syncEngine: SyncEngine | null = null;
	private apiClient: SyncApiClient | null = null;
	private stateChangeListeners = new Set<(state: SyncState) => void>();
	private activityProgress: SyncActivityProgress | null = null;
	private progressListeners = new Set<(current: number, total: number) => void>();
	private acceptingEvents = false;
	private initializationError: string | null = null;
	private initializationRevision = 0;
	private stoppingWork: Promise<void> = Promise.resolve();
	private stopSyncTask: Promise<void> | null = null;
	private configurationChain: Promise<void> = Promise.resolve();
	private startupSyncTask: Promise<boolean> = Promise.resolve(false);
	private foregroundSyncTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly serverStatus: RuntimeServerStatus;

	async loadCurrentSyncedPreview(path: string) {
		const api = this.apiClient;
		if (!api) throw new Error('Sync is not configured');
		const preview = await loadCurrentSyncedPreview(api, path);
		if (api !== this.apiClient) throw new Error('Sync configuration changed. Reopen file history.');
		return preview;
	}

	async loadFileHistoryPreview(version: RemoteFileVersion) {
		const api = this.apiClient;
		if (!api) throw new Error('Sync is not configured');
		const preview = await loadFileHistoryPreview(this.plugin.app.vault.adapter, api, version);
		if (api !== this.apiClient) throw new Error('Sync configuration changed. Reopen file history.');
		return preview;
	}

	async listRecentFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		if (!this.apiClient) throw new Error('Sync is not configured');
		return this.apiClient.listFileVersions(query);
	}

	async restoreRecentFileVersion(version: RemoteFileVersion): Promise<SyncResult> {
		if (!this.apiClient) throw new Error('Sync is not configured');
		const api = this.apiClient;
		await api.restoreFileVersion(version);
		if (api !== this.apiClient) throw new DOMException('Sync configuration changed during restore', 'AbortError');
		const result = await this.sync();
		if (result.success) await api.finishRestore(version.storage_key);
		return result;
	}
	getPendingRestores(): RemoteFileVersion[] { return this.apiClient?.getPendingRestores() ?? []; }
	private lastForegroundSyncAt: number | null = null;

	constructor(
		private plugin: Plugin,
		private settings: CrateSettings,
		private secretStorage: SecretStorageService,
		private persistSettings: (update?: Partial<CrateSettings>) => Promise<void>,
    private prepareReminderScope?: () => Promise<void>,
	) {
		this.serverStatus = new RuntimeServerStatus({
			settings,
			getClient: () => this.apiClient,
			captureIdleState: () => {
				const engine = this.syncEngine;
				if (!engine || engine.getState().status !== 'idle') return null;
				const revision = this.initializationRevision;
				const lastSync = engine.getState().lastSync;
				return () => this.initializationRevision === revision && this.syncEngine === engine
					&& engine.getState().status === 'idle' && engine.getState().lastSync === lastSync;
			},
			onIssueChange: () => this.emitCurrentState(),
		});
	}

	isInitialized(): boolean {
		return this.syncEngine !== null;
	}

	getState(): SyncState {
		if (this.syncEngine) {
			const state = this.syncEngine.getState();
			return this.serverStatus.issue && state.status === 'idle'
				? { ...state, status: 'offline', lastError: this.serverStatus.issue, lastIssues: undefined }
				: state;
		}
		return { status: this.initializationError ? 'error' : 'idle', lastSync: null, lastError: this.initializationError, pendingChanges: 0, conflictCount: 0 };
	}

	getPendingPaths(): string[] {
		return this.syncEngine?.getPendingPaths() ?? [];
	}

	async loadPendingDiff(path: string, deleted: boolean) {
		const engine = this.syncEngine;
		if (!engine) throw new Error('Sync is not initialized');
		const pendingPath = deleted ? `delete:${path}` : path;
		const verify = () => {
			if (engine !== this.syncEngine || this.getState().status === 'syncing' || !this.getPendingPaths().includes(pendingPath)) {
				throw new Error('Pending changes were updated. Reopen the file to refresh its preview.');
			}
		};
		verify();
		const preview = await engine.loadPendingDiff(path, deleted);
		verify();
		return preview;
	}

	getCachedVersionInfo(): CrateServerInfo | undefined {
		return this.serverStatus.getCachedVersionInfo();
	}

	getVersionInfo(): Promise<CrateServerInfo> {
		return this.serverStatus.getVersionInfo();
	}

	exportDiagnostics(): string {
		return buildDiagnosticExport(this.settings, this.getState(), this.plugin.manifest.version, this.apiClient?.getRequestDiagnostics(), this.serverStatus.getDiagnosticVersionInfo());
	}

	async previewIgnoredRemoteFiles(): Promise<string[]> {
		if (!this.syncEngine) throw new Error('Sync is not configured');
		return this.syncEngine.previewIgnoredRemoteFiles();
	}

	async purgeIgnoredRemoteFiles(): Promise<{ deleted: string[]; errors: string[] }> {
		if (!this.syncEngine) throw new Error('Sync is not configured');
		return this.syncEngine.purgeIgnoredRemoteFiles();
	}

	async createConflictReview(record: ConflictRecord) {
		if (!this.syncEngine || !this.getActiveConflicts().some(item => item.conflictPath === record.conflictPath)) throw new Error('Conflict is no longer active');
		const engine = this.syncEngine;
		const review = await createConflictReview(this.plugin.app, this.plugin.manifest.dir!, record, () => this.syncEngine !== engine,
			() => engine.markConflictResolved(record.conflictPath), {
				beforeBinaryReplace: path => engine.prepareRecoverableReplacement(path),
				beforeKeepLocal: () => engine.acceptIncomingConflictBaseline(record),
			});
		return { ...review, resolve: (choice: import('./conflict-review').ConflictChoice, editedText?: string) => engine.runConflictResolution(() => review.resolve(choice, editedText)) };
	}

	getActiveConflicts(): ConflictRecord[] {
		return this.syncEngine?.getActiveConflicts() ?? [];
	}

	addStateChangeListener(listener: (state: SyncState) => void): void {
		this.stateChangeListeners.add(listener);
	}

	removeStateChangeListener(listener: (state: SyncState) => void): void {
		this.stateChangeListeners.delete(listener);
	}

	getActivityProgress(): SyncActivityProgress | null {
		return this.activityProgress ? { ...this.activityProgress } : null;
	}

	addProgressListener(listener: (current: number, total: number) => void): void {
		this.progressListeners.add(listener);
	}

	removeProgressListener(listener: (current: number, total: number) => void): void {
		this.progressListeners.delete(listener);
	}

	isConfigured(): boolean {
		return this.settings.workerUrl.length > 0 && this.secretStorage.has(SECRET_KEYS.AUTH_TOKEN);
	}

	getApiClient(): SyncApiClient | null {
		return this.apiClient;
	}

	waitForStartupSync(): Promise<boolean> {
		return this.startupSyncTask;
	}

	async initialize(options: { skipStartupSync?: boolean; resumeEncryptionReset?: boolean } = {}): Promise<void> {
		logger.info('Initializing sync engine');

		const initializationRevision = ++this.initializationRevision;
		this.initializationError = null;
		this.acceptingEvents = false;
		this.startupSyncTask = Promise.resolve(false);
		this.clearForegroundSyncTimer();
		this.serverStatus.reset();

		this.stopEngine();
		this.activityProgress = null;
		this.emitCurrentState();

		await this.stoppingWork;
		if (this.initializationRevision !== initializationRevision) return;
		if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) {
			this.apiClient = null;
			this.initializationError = 'An encrypted folder move is unfinished. Open Manage encryption to resume on this device.';
			this.emitCurrentState();
			return;
		}
		if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET) && !options.resumeEncryptionReset) {
			this.apiClient = null;
			this.initializationError = 'Encryption reset is unfinished. Open Manage encryption to resume on this device.';
			this.emitCurrentState();
			return;
		}

		this.apiClient = new SyncApiClient(
			this.settings.workerUrl,
			this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || ''
		);
		try {
			const keys = loadEncryptionKeys(this.secretStorage);
			if (keys) await this.apiClient.configureEncryption(keys);
		} catch (error) {
			if (this.initializationRevision !== initializationRevision) return;
			this.initializationError = errorMessage(error);
			this.apiClient = null;
			this.emitCurrentState();
			throw error;
		}
		if (this.initializationRevision !== initializationRevision) return;
		this.syncEngine = new SyncEngine(this.plugin, this.apiClient, options.resumeEncryptionReset ? { ...this.settings, automaticSync: false } : this.settings);
		const syncEngine = this.syncEngine;
		syncEngine.setAutomaticSyncResultCallback(result => this.recordAutomaticSyncResult(syncEngine, result));
		syncEngine.setReminderScopePreparation(this.prepareReminderScope);

		this.emitCurrentState();

		this.syncEngine.setStateChangeCallback((state: SyncState) => {
			if (this.syncEngine !== syncEngine || this.initializationRevision !== initializationRevision) return;
			if (state.status === 'syncing') this.serverStatus.clearIssue();
			this.emitCurrentState();
		});

		try {
			await syncEngine.initialize();
		} catch (error) {
			if (this.initializationRevision !== initializationRevision || this.syncEngine !== syncEngine) return;
			this.initializationError = errorMessage(error);
			this.stopEngine();
			this.apiClient = null;
			this.emitCurrentState();
			throw error;
		}
		if (this.initializationRevision !== initializationRevision || this.syncEngine !== syncEngine) {
			return;
		}
		this.emitCurrentState();

		if (this.settings.automaticSync && !options.skipStartupSync) {
			this.startupSyncTask = this.sync()
				.then(async result => {
					notifyConflicts(result.conflicts);
					if (
						result.success
						&& this.initializationRevision === initializationRevision
						&& this.syncEngine === syncEngine
					) {
						// Resume event capture before probing so edits made after the
						// startup operation cannot fall into a second blind window.
						this.acceptingEvents = true;
						if (await syncEngine.hasUnsyncedLocalChanges() && this.settings.automaticSync) {
							logger.info('Local changes detected after startup sync; running a recovery pass');
							const recoveryResult = await this.sync();
							notifyConflicts(recoveryResult.conflicts);
						}
					}
					return true;
				})
				.catch(error => {
					logger.error('Startup sync failed:', error);
					return true;
				})
				.finally(() => {
					if (this.initializationRevision === initializationRevision && this.syncEngine === syncEngine) {
						this.acceptingEvents = true;
					}
				});
			return;
		}

		this.acceptingEvents = true;
		if (!this.settings.automaticSync) this.scheduleServerCheck();
	}

	destroy(): void {
		this.initializationRevision++;
		this.acceptingEvents = false;
		this.startupSyncTask = Promise.resolve(false);
		this.clearForegroundSyncTimer();
		this.serverStatus.reset();
		this.stopEngine();
		this.apiClient = null;
		this.activityProgress = null;
		this.initializationError = null;
		this.emitCurrentState();
	}

	stopSync(): Promise<void> {
		if (this.stopSyncTask) return this.stopSyncTask;
		// Abort immediately, before waiting for disk work or settings persistence.
		this.settings.automaticSync = false;
		this.destroy();
		const revision = this.initializationRevision;
		this.activityProgress = null;
		this.stopSyncTask = this.changeConfiguration(async () => {
			await this.stoppingWork;
			this.assertTransitionActive(revision);
			await this.persistSettings({ automaticSync: false });
			this.assertTransitionActive(revision);
			if (this.isConfigured()) await this.initialize({ skipStartupSync: true });
		}).finally(() => {
			this.stopSyncTask = null;
			this.emitCurrentState();
		});
		this.emitCurrentState();
		emitSyncProgress(this.progressListeners, 0, 0);
		return this.stopSyncTask;
	}

	private stopEngine(): void {
		const engine = this.syncEngine;
		this.syncEngine = null;
		engine?.destroy();
		this.stoppingWork = Promise.allSettled([this.stoppingWork, engine?.waitForIdle()]).then(() => {});
	}

	private changeConfiguration(operation: () => Promise<void>): Promise<void> {
		const task = this.configurationChain.then(operation);
		this.configurationChain = task.catch(() => {});
		return task;
	}

	/** Keep the current connection stable and wait for local journal I/O before
	 * moving its server into conversion. Failed conversions remain resumable. */
	runEncryptionSetup(operation: () => Promise<void>): Promise<void> {
		// Capture authority before queuing: a stopped or replaced connection must
		// not begin conversion or resume sync after an older operation completes.
		const transition = this.configurationTransition();
		return this.changeConfiguration(async () => {
			transition.verify();
			transition.stop();
			await transition.waitForIdle();
			transition.verify();
			await operation();
			await transition.initialize();
		});
	}

	/** A durable checkpoint blocks ordinary sync until reset and reconciliation finish. */
	turnOffEncryption(state: EncryptionServerState | null, progress: (message: string) => void,
		expected: { workerUrl: string; authToken: string }, signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(() => runEncryptionReset({
			settings: this.settings, secretStorage: this.secretStorage,
			transition: this.configurationTransition(signal), persistSettings: this.persistSettings,
			clearLocalState: () => deleteManifestFile(this.plugin, signal),
			getResetEngine: () => {
				this.acceptingEvents = false;
				if (!this.syncEngine || !this.apiClient) throw new Error('Could not start the new sync connection');
				return this.syncEngine;
			},
			pushSharedSettings: () => this.pushSharedSettingsBestEffort(),
			resumeEvents: () => { this.acceptingEvents = true; },
			reportError: message => { this.initializationError = message; this.emitCurrentState(); },
		}, state, progress, expected, signal));
	}

	private configurationTransition(signal?: AbortSignal): RuntimeConfigurationTransition {
		let revision = this.initializationRevision;
		const verify = () => this.assertTransitionActive(revision, signal);
		return {
			verify,
			stop: () => { this.destroy(); revision = this.initializationRevision; },
			waitForIdle: () => this.stoppingWork,
			initialize: async (resumeEncryptionReset = false) => {
				verify();
				const initializing = this.initialize({ skipStartupSync: true, resumeEncryptionReset });
				// initialize establishes its generation synchronously before yielding.
				// Capture that authority here; workflows never predict its revision.
				revision = this.initializationRevision;
				await initializing;
				verify();
			},
		};
	}

	private assertTransitionActive(revision: number, signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.initializationRevision !== revision) throw new DOMException('Sync configuration changed during reset', 'AbortError');
	}

	onRawFileChange(path: string): void {
		if (this.plugin.app.workspace.layoutReady === false || !this.acceptingEvents) return;
		void this.syncEngine?.onRawFileChange(path);
	}

	onFileChange(file: TAbstractFile): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path)) return;
		this.syncEngine?.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path)) return;
		this.syncEngine?.onFileDelete(file);
	}

	getRenameDependencies(): Record<string, string> { return this.syncEngine?.getRenameDependencies() ?? {}; }

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path) && !isConflictFile(oldPath)) return;
		this.syncEngine?.onFileRename(file, oldPath);
	}

	triggerForegroundSync(reason: ForegroundSyncReason): void {
		if (!this.settings.automaticSync) {
			this.scheduleServerCheck();
			return;
		}
		if (!this.acceptingEvents || !this.isConfigured() || !this.syncEngine) return;
		if (this.syncEngine.getState().status === 'syncing') return;
		if (this.foregroundSyncTimer) return;

		if (this.isForegroundSyncOnCooldown()) {
			return;
		}

		this.foregroundSyncTimer = setTimeout(() => {
			this.foregroundSyncTimer = null;
			void this.runForegroundSync(reason);
		}, FOREGROUND_SYNC_DEBOUNCE_MS);
	}

	/** Authenticate a changed transport address without losing pending disk work. */
	updateEncryptedServerAddress(address: string, signal: AbortSignal, expected: { workerUrl: string; authToken: string }): Promise<void> {
		return this.changeConfiguration(() => changeEncryptedServerAddress(this.addressWorkflowContext(signal), address, signal, expected));
	}

	/** Relocate only the same self-hosted reset, retaining both scopes until settings save. */
	updateEncryptionResetAddress(address: string, signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(() => changeEncryptionResetAddress(this.addressWorkflowContext(signal), address, signal));
	}

	private addressWorkflowContext(signal?: AbortSignal) {
		return {
			settings: this.settings, secretStorage: this.secretStorage,
			transition: this.configurationTransition(signal), persistSettings: this.persistSettings,
			clearLocalState: () => deleteManifestFile(this.plugin, signal),
			emitCurrentState: () => this.emitCurrentState(),
		};
	}

	async applyInfrastructureConfig(config: ApplyInfrastructureConfigInput, signal?: AbortSignal, expected?: ApplyInfrastructureConfigInput): Promise<void> {
		return this.changeConfiguration(async () => {
			if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) throw new Error('Resume the encrypted folder move before changing this device’s connection.');
			if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Resume the encryption reset before changing this device’s connection.');
			signal?.throwIfAborted();
			if (expected && (this.settings.workerUrl !== expected.workerUrl || this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== expected.authToken)) {
				throw new Error('The server connection changed. Reopen settings and try again.');
			}
			const workerUrl = requireNormalizedWorkerUrl(config.workerUrl);
			if (!config.authToken.trim()) throw new Error('Auth token is required');
			const changingServer = workerUrl !== normalizeWorkerUrl(this.settings.workerUrl);
			this.destroy();
			const revision = this.initializationRevision;
			await this.stoppingWork;
			this.assertTransitionActive(revision, signal);
			if (changingServer) await deleteManifestFile(this.plugin, signal);
			this.assertTransitionActive(revision, signal);
			applyInfrastructureConfigState(this.settings, this.secretStorage, { ...config, workerUrl });
			if (config.encryption) saveEncryptionKeys(this.secretStorage, config.encryption.bundle, config.encryption.recovery);
			if (changingServer) resetStoredSyncState(this.settings);
			await this.persistSettings();
			this.assertTransitionActive(revision, signal);
			await this.initialize({ skipStartupSync: true });
		});
	}

	async clearSyncConfiguration(signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(async () => {
			if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) throw new Error('Resume the encrypted folder move before disconnecting this device.');
			if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Resume the encryption reset before disconnecting this device.');
			signal?.throwIfAborted();
			const api = this.apiClient;
			this.destroy();
			const revision = this.initializationRevision;
			await this.stoppingWork;
			this.assertTransitionActive(revision, signal);
			try {
				// The stopped engine aborted this client. Revocation is a separate,
				// explicitly requested operation after all old work has settled.
				api?.setAbortSignal(signal ?? new AbortController().signal);
				await api?.revokeCurrentToken();
			} catch (error) {
				logger.warn('Failed to revoke the current device credential:', error);
			}
			this.assertTransitionActive(revision, signal);
			await deleteManifestFile(this.plugin, signal);
			this.assertTransitionActive(revision, signal);
			resetStoredSyncState(this.settings);
			clearSyncConfigurationState(this.settings, this.secretStorage);
			await this.persistSettings();
		});
	}

	updateSyncSettings(): void {
		if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) return;
		this.syncEngine?.updateSettings(this.settings);
		if (this.settings.automaticSync) this.serverStatus.cancelCheck();
		else this.scheduleServerCheck();
	}

	async pushSharedSettingsBestEffort(): Promise<boolean> {
		if (!this.apiClient) return false;
		try {
			await this.apiClient.putSharedSettings(buildSharedSettings(this.settings));
			return true;
		} catch (error) {
			logger.error('Failed to push shared settings:', error);
			return false;
		}
	}

	async testConnection(): Promise<ConnectionTestResult> {
		if (!this.apiClient) {
			return { success: false, error: 'Not configured' };
		}
		return this.apiClient.testConnection();
	}

	private clearForegroundSyncTimer(): void {
		if (this.foregroundSyncTimer) {
			clearTimeout(this.foregroundSyncTimer);
			this.foregroundSyncTimer = null;
		}
	}

	private scheduleServerCheck(): void {
		if (!this.acceptingEvents || !this.isConfigured() || !this.syncEngine) return;
		this.serverStatus.scheduleCheck();
	}

	private isForegroundSyncOnCooldown(): boolean {
		return this.lastForegroundSyncAt !== null
			&& Date.now() - this.lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS;
	}

	private async runForegroundSync(reason: ForegroundSyncReason): Promise<void> {
		if (!this.settings.automaticSync) return;
		if (!this.acceptingEvents || !this.isConfigured() || !this.syncEngine) return;
		if (this.syncEngine.getState().status === 'syncing') return;
		if (this.isForegroundSyncOnCooldown()) return;

		this.lastForegroundSyncAt = Date.now();
		logger.info(`Foreground sync triggered: ${reason}`);

		try {
			const result = await this.sync();
			notifyConflicts(result.conflicts);
		} catch (error) {
			logger.warn('Foreground sync failed:', error);
		}
	}

	private async recordSyncResult(engine: SyncEngine, type: SyncHistoryEntry['type'], result: SyncResult): Promise<void> {
		if (this.syncEngine !== engine) return;
		const api = this.apiClient;
		recordSyncHistory(this.settings, type, result);
		const latest = this.settings.syncHistory[0];
		if (latest) latest.timings = engine.getTimings();
		if (latest && api) latest.requestDiagnostics = api.getRequestDiagnostics();
		if (latest && result.success && !result.conflicts.length) {
			try {
                const shared = await engine.saveSharedHistoryCheckpoint();
                if (this.syncEngine !== engine) return;
                if (shared) latest.sharedCheckpoint = shared.id;
                else {
                    const checkpoint = await engine.saveHistoryCheckpoint();
                    if (this.syncEngine === engine) latest.historyCheckpoint = checkpoint;
                }
            }
			catch (error) { if (this.syncEngine === engine) logger.warn('Could not save the history checkpoint:', errorMessage(error)); }
		}
	}

	private emitCurrentState(): void {
		emitStateChange(this.stateChangeListeners, this.getState());
	}

	private async recordAutomaticSyncResult(engine: SyncEngine, result: SyncResult): Promise<void> {
		if (this.syncEngine !== engine) return;
		const state = engine.getState();
		if (result.success && state.lastSync) {
			this.settings.lastSync = state.lastSync;
		}
		await this.recordSyncResult(engine, 'sync', result);
		if (this.syncEngine !== engine) return;
		this.emitCurrentState();
		try {
			await this.persistSettings();
		} catch (error) {
			logger.error('Failed to persist automatic sync activity:', error);
		}
	}

	private async runSyncOperation(
		type: SyncHistoryEntry['type'],
		operation: (engine: SyncEngine, progress: (current: number, total: number) => void) => Promise<SyncResult>,
		progressCallback?: (current: number, total: number) => void,
		logMessage?: string,
	): Promise<SyncResult> {
		if (this.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) return createSyncFailureResult('Open Manage encryption to finish the reset before syncing.');
		if (this.stopSyncTask) return createSyncFailureResult('Sync is stopping. Try again when it finishes.');
		if (!this.syncEngine) return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);

		const engine = this.syncEngine;
		if (logMessage) {
			logger.info(logMessage);
		}

		const active: SyncActivityProgress = { type, current: 0, total: 0 };
		this.activityProgress = active;
		emitSyncProgress(this.progressListeners, 0, 0);
		const wrappedCallback = (current: number, total: number) => {
			if (this.syncEngine !== engine) return;
			Object.assign(active, { current, total });
			emitSyncProgress(this.progressListeners, current, total, {
				onExternalProgress: progressCallback,
			});
		};
		try {
			const result = await operation(engine, wrappedCallback);
			if (this.syncEngine !== engine) return result;
			// The engine is finished, but checkpoint and settings persistence can
			// still take time. Keep that work visible after the engine clears its phase.
			active.work = { phase: 'saving' };
			emitSyncProgress(this.progressListeners, active.current, active.total);
			if (type === 'sync') {
				this.lastForegroundSyncAt = Date.now();
			}
			await this.recordSyncResult(engine, type, result);
			if (this.syncEngine !== engine) return result;
			await this.persistSettings();
			return result;
		} finally {
			if (this.activityProgress === active) this.activityProgress = null;
			if (this.syncEngine === engine) {
				emitSyncProgress(this.progressListeners, 0, 0);
			}
		}
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'sync',
			(syncEngine, wrappedCallback) => syncEngine.sync(wrappedCallback),
			progressCallback,
			'Sync triggered',
		);
	}

    async syncSelected(keys: string[]): Promise<SyncResult> {
        return this.runSyncOperation('sync', engine => engine.syncSelected(keys));
    }

    async createPendingDiscard(keys: string[]) {
        if (!this.syncEngine) throw new Error('Sync is not configured.');
        return this.syncEngine.createPendingDiscard(keys);
    }

    async listSharedCheckpoints(): Promise<SharedCheckpoint[]> {
        const api = this.apiClient;
        if (!api) throw new Error('Sync is not configured.');
        const checkpoints = await api.sharedHistory.list();
        if (api !== this.apiClient) throw new Error('Sync connection changed. Reopen history.');
        return checkpoints;
    }

    async loadHistoryComparison(entry: SyncHistoryEntry) {
        const engine = this.syncEngine;
        if (!engine) throw new Error('Sync is not configured.');
        return loadRuntimeHistoryComparison(engine, () => this.verifyHistoryEngine(engine), entry);
    }

    async createHistoryRestore(entry: SyncHistoryEntry) {
        const engine = this.syncEngine;
        if (!engine) throw new Error('This history entry has no complete vault checkpoint.');
        return createRuntimeHistoryRestore({
            engine, settings: this.settings,
            verify: () => this.verifyHistoryEngine(engine),
            clearForegroundSyncTimer: () => this.clearForegroundSyncTimer(),
            persistSettings: update => this.persistSettings(update),
            runSyncOperation: operation => this.runSyncOperation('sync', operation),
        }, entry);
    }

    private verifyHistoryEngine(engine: SyncEngine): void {
        if (engine !== this.syncEngine) throw new Error('Sync connection changed. Reopen history.');
    }

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'initial',
			(syncEngine, wrappedCallback) => syncEngine.initialSync(wrappedCallback),
			progressCallback,
		);
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'force',
			(syncEngine, wrappedCallback) => syncEngine.forceFullSync(wrappedCallback),
			progressCallback,
		);
	}
}
