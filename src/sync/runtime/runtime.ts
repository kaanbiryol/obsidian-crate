import { pendingChangeKey, type PendingChange } from '../pending/pending-change';
import { createAbortError } from '../abort';
import type { ConnectionTestResult } from '../types';
import { createRuntimeHistoryRestore, loadRuntimeHistoryComparison } from './history-workflow';
import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
import { loadFileHistoryPreview, loadCurrentSyncedPreview } from '../history/file-history-preview';
import type { CrateServerInfo } from '../../protocol/server-info';
import { createConflictReview } from '../conflict/review';
import type { SyncActivityProgress } from '../types';
import { TFolder, type Plugin, type TAbstractFile } from 'obsidian';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';
import type { SecretStorageService } from '../../plugin/secret-storage';
import { loadEncryptionKeys } from '../encryption/key-storage';
import { runEncryptionReset, type EncryptionResetRequest } from './encryption-reset-workflow';
import { changeEncryptedServerAddress, changeEncryptionResetAddress } from './address-workflow';
import { changeServerConnection, disconnectServerConnection } from './connection-workflow';
import type { EncryptionServerState } from '../../encryption/server-state';
import type { VaultKeyBundle } from '../../encryption/key-bundle';
import type { ConflictRecord, SyncHistoryEntry, SyncResult, SyncState } from '../types';
import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';
import { SyncApiClient } from '../worker-api/client';
import { isConflictFile } from '../conflict/conflict';
import { SyncEngine } from '../engine/engine';
import { buildDiagnosticExport } from '../diagnostics/diagnostic-export';
import { deleteManifestFile, type ApplyInfrastructureConfigInput } from './config';
import { checkpointDue, recordSyncHistory } from './sync-activity';
import { createSyncFailureResult, SYNC_ERROR_MESSAGES } from '../sync-result';
import { RuntimeServerStatus } from './server-status';
import { ForegroundSyncScheduler, type ForegroundSyncReason } from './foreground-sync';
import { runStartupSync } from './startup-sync';
import { SECRET_KEYS } from '../../platform/secret-keys';
import { updateSyncProgress, type SyncRuntimeSettings, type SyncSettings } from '../settings';
import { buildSharedSettings } from '../connection/shared-settings';

const logger = createLogger('SyncRuntime');
const NOT_CONFIGURED = 'Sync is not configured.';
const FILE_HISTORY_CHANGED = 'Sync configuration changed. Reopen file history.';
const HISTORY_CHANGED = 'Sync connection changed. Reopen history.';

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
	/** Latest change implied by each vault event that arrived during the startup sync,
	 * which does not take events; queued once it finishes. */
	private startupEvents: Map<string, PendingChange['kind'] | 'raw'> | null = null;
	private initializing: boolean;
	private initializationError: string | null = null;
	private initializationRevision = 0;
	private stoppingWork: Promise<void> = Promise.resolve();
	private stopSyncTask: Promise<void> | null = null;
	private configurationChain: Promise<void> = Promise.resolve();
	private startupSyncTask: Promise<boolean> = Promise.resolve(false);
	private readonly foregroundSync = new ForegroundSyncScheduler({
		canSync: () => this.settings.automaticSync && this.acceptingEvents && this.isConfigured()
			&& this.syncEngine !== null && this.syncEngine.getState().status !== 'syncing',
		sync: () => this.sync(),
	});
	private readonly serverStatus: RuntimeServerStatus;

	private requireEngine(): SyncEngine {
		if (!this.syncEngine) throw new Error(NOT_CONFIGURED);
		return this.syncEngine;
	}

	private requireApi(): SyncApiClient {
		if (!this.apiClient) throw new Error(NOT_CONFIGURED);
		return this.apiClient;
	}

	/** Each engine belongs to one initialize() call. initialize() and destroy() clear it
	 * synchronously whenever they advance the revision, so a current engine also means
	 * the revision and the API client it was built on are unchanged. */
	private assertCurrentEngine(engine: SyncEngine, stale: () => Error): void {
		if (engine !== this.syncEngine) throw stale();
	}

	/** The API client is created before its engine and kept while initialize() waits for
	 * the old engine to stop, so server reads check only the client they used. */
	/** Runs `read` against the current API client and rejects with `staleMessage` when the
	 * runtime replaced that client before `read` settled. Multi-step reads check `isCurrent`
	 * before acting on an earlier response. */
	async withCurrentApi<T>(read: (api: SyncApiClient, isCurrent: () => boolean) => Promise<T>, staleMessage: string): Promise<T> {
		const api = this.requireApi();
		const result = await read(api, () => api === this.apiClient);
		if (api !== this.apiClient) throw new Error(staleMessage);
		return result;
	}

	loadCurrentSyncedPreview(path: string) {
		return this.withCurrentApi(api => loadCurrentSyncedPreview(api, path), FILE_HISTORY_CHANGED);
	}

	loadFileHistoryPreview(version: RemoteFileVersion) {
		return this.withCurrentApi(api => loadFileHistoryPreview(this.plugin.app.vault.adapter, api, version), FILE_HISTORY_CHANGED);
	}

	listRecentFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		return this.withCurrentApi(api => api.listFileVersions(query), FILE_HISTORY_CHANGED);
	}

	listSharedCheckpoints(): Promise<SharedCheckpoint[]> {
		return this.withCurrentApi(api => api.sharedHistory.list(), HISTORY_CHANGED);
	}

	async restoreRecentFileVersion(version: RemoteFileVersion): Promise<SyncResult> {
		const engine = this.requireEngine();
		const stale = () => createAbortError('Sync configuration changed during restore');
		await engine.restoreFileVersion(version);
		this.assertCurrentEngine(engine, stale);
		const result = await this.sync();
		this.assertCurrentEngine(engine, stale);
		if (result.success) await engine.finishRestore(version.storage_key);
		return result;
	}
	getPendingRestores(): RemoteFileVersion[] { return this.syncEngine?.getPendingRestores() ?? []; }
	private lastCheckpointAt = 0;

	constructor(
		private plugin: Plugin,
		private settings: SyncRuntimeSettings,
		private secretStorage: SecretStorageService,
		private persistSettings: (update?: Partial<SyncSettings>) => Promise<void>,
	private prepareReminderScope?: () => Promise<void>,
		/** Notes inside these folders carry encrypted notification schedules. */
		private reminderFolders: () => readonly string[] = () => [],
		/** Where notes the server sealed to the vault (Save to Crate captures) are accepted. */
		private readingFolder: () => string | null = () => null,
	) {
		this.initializing = this.isConfigured();
		this.serverStatus = new RuntimeServerStatus({
			settings,
			getClient: () => this.apiClient,
			captureIdleState: () => {
				const engine = this.syncEngine;
				if (!engine || engine.getState().status !== 'idle') return null;
				const lastSync = engine.getState().lastSync;
				return () => this.syncEngine === engine
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
			const state = { ...this.syncEngine.getState(), ...(this.initializing ? { initializing: true } : {}) };
			return this.serverStatus.issue && state.status === 'idle'
				? { ...state, status: 'offline', lastError: this.serverStatus.issue, lastIssues: undefined }
				: state;
		}
		return { status: this.initializationError ? 'error' : 'idle', lastSync: null, lastError: this.initializationError, pendingChanges: 0, conflictCount: 0,
			...(this.initializing && !this.initializationError ? { initializing: true } : {}),
		};
	}

	getPendingKeys(): string[] {
		return this.syncEngine?.getPendingKeys() ?? [];
	}

	getPendingChangeCount(): number {
		return this.syncEngine?.getPendingChangeCount() ?? 0;
	}

	hasPendingKey(key: string): boolean {
		return this.syncEngine?.hasPendingKey(key) ?? false;
	}

	async loadPendingDiff(path: string, deleted: boolean) {
		const engine = this.requireEngine();
		const pendingPath = pendingChangeKey(deleted ? 'delete' : 'upload', path);
		const verify = () => {
			if (engine !== this.syncEngine || this.getState().status === 'syncing' || !engine.hasPendingKey(pendingPath)) {
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
		return buildDiagnosticExport(this.settings, this.getState(), this.plugin.manifest.version, this.syncEngine?.getRequestDiagnostics() ?? this.apiClient?.getRequestDiagnostics(), this.serverStatus.getDiagnosticVersionInfo());
	}

	async createExclusionCleanupReview() {
		const engine = this.requireEngine();
		const verify = () => this.assertCurrentEngine(engine, () => createAbortError('Sync connection changed. Review the excluded server files again.'));
		const review = await engine.createExclusionCleanupReview();
		verify();
		return { ...review, execute: async () => {
			verify();
			const result = await review.execute();
			verify();
			return result;
		} };
	}

	async createConflictReview(record: ConflictRecord) {
		if (!this.syncEngine || !this.getActiveConflicts().some(item => item.conflictPath === record.conflictPath)) throw new Error('Conflict is no longer active');
		const engine = this.syncEngine;
		const review = await createConflictReview(this.plugin.app, this.plugin.manifest.dir!, record, () => this.syncEngine !== engine,
			() => engine.markConflictResolved(record.conflictPath), {
				beforeBinaryReplace: path => engine.prepareRecoverableReplacement(path),
				beforeKeepLocal: () => engine.acceptIncomingConflictBaseline(record),
			});
		return { ...review, resolve: (choice: import('../conflict/review').ConflictChoice, editedText?: string) => engine.runConflictResolution(() => review.resolve(choice, editedText)) };
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

	/** Resolves true once the startup sync ran to an outcome (success or failure), false if it was skipped or cancelled. */
	waitForStartupSync(): Promise<boolean> {
		return this.startupSyncTask;
	}

	async initialize(options: { skipStartupSync?: boolean; resumeEncryptionReset?: boolean } = {}): Promise<void> {
		logger.info('Initializing sync engine');

		const initializationRevision = ++this.initializationRevision;
		this.initializing = true;
		this.initializationError = null;
		this.acceptingEvents = false;
		this.startupEvents = null;
		this.startupSyncTask = Promise.resolve(false);
		this.foregroundSync.cancel();
		this.serverStatus.reset();

		this.stopEngine();
		this.activityProgress = null;
		this.emitCurrentState();

		await this.stoppingWork;
		if (this.initializationRevision !== initializationRevision) return;
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
			if (keys) await this.apiClient.configureEncryption(keys, this.reminderFolders, this.readingFolder);
		} catch (error) {
			if (this.initializationRevision !== initializationRevision) return;
			this.initializationError = errorMessage(error);
			this.apiClient = null;
			this.emitCurrentState();
			throw error;
		}
		if (this.initializationRevision !== initializationRevision) return;
		// A resumed encryption reset has already saved automatic sync as off. The engine
		// shares these settings so the reset upload's progress is persisted with them.
		this.syncEngine = new SyncEngine(this.plugin, this.apiClient, this.settings);
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
			// The startup sync scans the vault after this point; later events are replayed.
			this.startupEvents = new Map();
			this.startupSyncTask = runStartupSync({
				sync: () => this.sync(),
				isCurrent: () => this.initializationRevision === initializationRevision && this.syncEngine === syncEngine,
				finish: () => {
					this.acceptingEvents = true;
					this.queueStartupEvents(syncEngine);
					this.initializing = false;
					this.emitCurrentState();
				},
			});
			return;
		}

		this.acceptingEvents = true;
		this.initializing = false;
		this.emitCurrentState();
		if (!this.settings.automaticSync) this.scheduleServerCheck();
	}

	destroy(): void {
		this.initializationRevision++;
		this.initializing = false;
		this.acceptingEvents = false;
		this.startupEvents = null;
		this.startupSyncTask = Promise.resolve(false);
		this.foregroundSync.cancel();
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
		this.emitProgress(0, 0);
		return this.stopSyncTask;
	}

	private stopEngine(): void {
		const engine = this.syncEngine;
		this.syncEngine = null;
		engine?.destroy();
		this.stoppingWork = Promise.allSettled([this.stoppingWork, engine?.waitForIdle()]).then(() => {});
	}

	private changeConfiguration(operation: (transition: RuntimeConfigurationTransition) => Promise<void>, signal?: AbortSignal): Promise<void> {
		// Every queued operation belongs to the runtime that accepted it, even
		// when its caller has no signal or shutdown happens before dispatch.
		const transition = this.configurationTransition(signal);
		const task = this.configurationChain.then(() => {
			transition.verify();
			return operation(transition);
		});
		this.configurationChain = task.catch(() => {});
		return task;
	}

	/** Keep the current connection stable and wait for local journal I/O while
	 * this device's encryption keys change, then start sync again. */
	runEncryptionSetup(operation: () => Promise<void>): Promise<void> {
		return this.changeConfiguration(async transition => {
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
		return this.resetEncryption({ target: 'plain', state }, progress, expected, signal);
	}

	/** Replaces the server copy, its history and checkpoints with this device's vault, encrypted. */
	turnOnEncryption(bundle: VaultKeyBundle, recovery: string, progress: (message: string) => void,
		expected: { workerUrl: string; authToken: string }, signal?: AbortSignal): Promise<void> {
		return this.resetEncryption({ target: 'encrypted', bundle, recovery }, progress, expected, signal);
	}

	private resetEncryption(request: EncryptionResetRequest, progress: (message: string) => void,
		expected: { workerUrl: string; authToken: string }, signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(transition => runEncryptionReset({
			settings: this.settings, secretStorage: this.secretStorage,
			transition, persistSettings: this.persistSettings,
			clearLocalState: () => deleteManifestFile(this.plugin, signal),
			getResetEngine: () => {
				this.acceptingEvents = false;
				if (!this.syncEngine || !this.apiClient) throw new Error('Could not start the new sync connection');
				return this.syncEngine;
			},
			pushSharedSettings: () => this.pushSharedSettingsBestEffort(),
			syncBeforeEncrypting: async () => {
				if (!this.syncEngine) throw new Error('Connect sync on this device before enabling encryption');
				const result = await this.syncEngine.sync();
				if (result.outcome === 'cancelled' || !result.success || result.conflicts.length) {
					throw new Error('Sync this device without errors or conflicts first, so no server-only changes are lost.');
				}
			},
			resumeEvents: () => { this.acceptingEvents = true; },
			reportError: message => { this.initializationError = message; this.emitCurrentState(); },
		}, request, progress, expected, signal), signal);
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
		if (this.initializationRevision !== revision) throw createAbortError('Sync configuration changed during reset');
	}

	onRawFileChange(path: string): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents) {
			// Raw notifications stand in for hidden files only; a vault event for the path wins.
			if (!this.startupEvents?.has(path)) this.startupEvents?.set(path, 'raw');
			return;
		}
		void this.syncEngine?.onRawFileChange(path);
	}

	onFileChange(file: TAbstractFile): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path)) {
			if (!(file instanceof TFolder)) this.startupEvents?.set(file.path, 'upload');
			return;
		}
		this.syncEngine?.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path)) {
			if (!(file instanceof TFolder)) this.startupEvents?.set(file.path, 'delete');
			return;
		}
		this.syncEngine?.onFileDelete(file);
	}


	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path) && !isConflictFile(oldPath)) {
			if (!(file instanceof TFolder)) this.startupEvents?.set(oldPath, 'delete').set(file.path, 'upload');
			return;
		}
		this.syncEngine?.onFileRename(file, oldPath);
	}

	/** Replays events the startup sync dropped; pending verification settles download
	 * echoes and other files that still match their baseline. */
	private queueStartupEvents(engine: SyncEngine): void {
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

	triggerForegroundSync(reason: ForegroundSyncReason): void {
		if (!this.settings.automaticSync) this.scheduleServerCheck();
		else this.foregroundSync.trigger(reason);
	}

	/** Authenticate a changed transport address without losing pending disk work. */
	updateEncryptedServerAddress(address: string, signal: AbortSignal, expected: { workerUrl: string; authToken: string }): Promise<void> {
		return this.changeConfiguration(transition => changeEncryptedServerAddress(this.addressWorkflowContext(transition, signal), address, signal, expected), signal);
	}

	/** Relocate only the same self-hosted reset, retaining both scopes until settings save. */
	updateEncryptionResetAddress(address: string, signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(transition => changeEncryptionResetAddress(this.addressWorkflowContext(transition, signal), address, signal), signal);
	}

	private addressWorkflowContext(transition: RuntimeConfigurationTransition, signal?: AbortSignal) {
		return {
			settings: this.settings, secretStorage: this.secretStorage,
			transition, persistSettings: this.persistSettings,
			clearLocalState: () => deleteManifestFile(this.plugin, signal),
			emitCurrentState: () => this.emitCurrentState(),
		};
	}

	async applyInfrastructureConfig(config: ApplyInfrastructureConfigInput, signal?: AbortSignal, expected?: ApplyInfrastructureConfigInput): Promise<void> {
		return this.changeConfiguration(transition => changeServerConnection(this.connectionWorkflowContext(transition, signal), config, expected), signal);
	}

	async clearSyncConfiguration(signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(transition => disconnectServerConnection(this.connectionWorkflowContext(transition, signal), signal), signal);
	}

	private connectionWorkflowContext(transition: RuntimeConfigurationTransition, signal?: AbortSignal) {
		return {
			settings: this.settings, secretStorage: this.secretStorage, api: this.apiClient,
			transition, persistSettings: this.persistSettings,
			clearLocalState: () => deleteManifestFile(this.plugin, signal),
		};
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

	private scheduleServerCheck(): void {
		if (!this.acceptingEvents || !this.isConfigured() || !this.syncEngine) return;
		this.serverStatus.scheduleCheck();
	}

	private async recordSyncResult(engine: SyncEngine, type: SyncHistoryEntry['type'], result: SyncResult): Promise<void> {
		if (this.syncEngine !== engine || result.outcome === 'cancelled') return;
		const api = this.apiClient;
		const latest = recordSyncHistory(this.settings, type, result, {
			timings: engine.getTimings(),
			...(api ? { requestDiagnostics: engine.getRequestDiagnostics() } : {}),
		});
		if (result.success && !result.conflicts.length && checkpointDue({
			type, history: this.settings.syncHistory, latest, lastCheckpointAt: this.lastCheckpointAt,
			trackedFiles: engine.trackedFileCount(), now: Date.now(),
		})) {
			// The server rejects vaults above the shared limits; they get no checkpoint. A failed
			// attempt waits as long as a saved one, so it is not retried after every sync.
			this.lastCheckpointAt = Date.now();
			try {
				const shared = await engine.saveSharedHistoryCheckpoint();
				if (this.syncEngine !== engine || !shared) return;
				updateSyncProgress(this.settings, { syncHistory: this.settings.syncHistory.map(entry => entry === latest ? { ...entry, sharedCheckpoint: shared.id } : entry) });
			}
			catch (error) { if (this.syncEngine === engine) logger.warn('Could not save the history checkpoint:', errorMessage(error)); }
		}
	}

	private emitCurrentState(): void {
		const state = this.getState();
		for (const listener of this.stateChangeListeners) listener(state);
	}

	private emitProgress(current: number, total: number): void {
		for (const listener of this.progressListeners) listener(current, total);
	}

	/** The engine already recorded `lastSync` in these settings while publishing the result. */
	private async recordAutomaticSyncResult(engine: SyncEngine, result: SyncResult): Promise<void> {
		if (this.syncEngine !== engine || result.outcome === 'cancelled') return;
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
		type: SyncActivityProgress['type'],
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
		this.emitProgress(0, 0);
		const wrappedCallback = (current: number, total: number) => {
			if (this.syncEngine !== engine) return;
			Object.assign(active, { current, total });
			progressCallback?.(current, total);
			this.emitProgress(current, total);
		};
		try {
			const result = await operation(engine, wrappedCallback);
			if (this.syncEngine !== engine || result.outcome === 'cancelled') return result;
			// The engine is finished, but checkpoint and settings persistence can
			// still take time. Keep that work visible after the engine clears its phase.
			active.work = { phase: 'saving' };
			this.emitProgress(active.current, active.total);
			if (type === 'sync') this.foregroundSync.recordSync();
			await this.recordSyncResult(engine, type, result);
			if (this.syncEngine !== engine) return result;
			await this.persistSettings();
			return result;
		} finally {
			if (this.activityProgress === active) this.activityProgress = null;
			if (this.syncEngine === engine) {
				this.emitProgress(0, 0);
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

	/** In an encrypted vault, notes already inside a newly chosen Reminders folder carry
	 * no notification schedules until uploaded again. Runs after any sync in progress. */
	async republishReminderNotes(folder: string): Promise<void> {
		const engine = this.syncEngine;
		if (!engine || !loadEncryptionKeys(this.secretStorage)) return;
		if (engine.getState().status === 'syncing') await new Promise<void>(resolve => {
			const listener = (state: SyncState) => {
				if (state.status === 'syncing' && this.syncEngine === engine) return;
				this.removeStateChangeListener(listener); resolve();
			};
			this.addStateChangeListener(listener);
		});
		if (this.syncEngine === engine) await engine.republishMarkdown(folder);
	}

	async createPendingDiscard(keys: string[]) {
		return this.requireEngine().createPendingDiscard(keys);
	}

	async loadHistoryComparison(entry: SyncHistoryEntry) {
		const engine = this.requireEngine();
		return loadRuntimeHistoryComparison(engine, () => this.verifyHistoryEngine(engine), entry);
	}

	async createHistoryRestore(entry: SyncHistoryEntry) {
		const engine = this.requireEngine();
		return createRuntimeHistoryRestore({
			engine, settings: this.settings,
			verify: () => this.verifyHistoryEngine(engine),
			clearForegroundSyncTimer: () => this.foregroundSync.cancel(),
			persistSettings: update => this.persistSettings(update),
			runSyncOperation: operation => this.runSyncOperation('sync', operation),
		}, entry);
	}

	private verifyHistoryEngine(engine: SyncEngine): void {
		this.assertCurrentEngine(engine, () => new Error(HISTORY_CHANGED));
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'force',
			(syncEngine, wrappedCallback) => syncEngine.forceFullSync(wrappedCallback),
			progressCallback,
		);
	}
}
