import { createEngineFileOperations } from '../engine/file-operations';
import type { ConnectionTestResult } from '../types';
import { SharedHistoryApi } from './history-checkpoints';
import type { RequestDiagnostics } from '../diagnostics/request-diagnostics';
import type { MarkdownBaseCache } from '../merge/markdown-base-cache';
import type { Vault } from 'obsidian';
import type { LocalManifest } from '../manifest/manifest';
import type { NotificationPolicy } from '../../protocol/notification-policy';
/**
 * Worker API client facade for sync, setup, and reminder endpoints.
 */

import type {
	BackendDiagnostics,
	ChangesResponse,
	CheckResponse,
	FileManifest,
	FileMetadataResponse,
	HealthResponse,
	RegisteredDevice,
	FileVersionQuery,
	FileVersionsPage,
	RemoteFileVersion,
} from '../../protocol/sync-types';
import type { SharedSettings } from '../../protocol/shared-settings';
import type { CrateServerInfo } from '../../protocol/server-info';
import { AuthWorkerApi } from './auth';
import { WorkerApiHttpClient } from './http';
import type { ApiHttpTransport } from './http';
import type {
	PushSubscriptionsResponse,
	PushTestResponse,
} from './notifications';
import { NotificationsWorkerApi } from './notifications';
import { SharedSettingsWorkerApi, type VersionedSharedSettings } from './shared-settings';
import { SyncWorkerApi, type DownloadedBatch, type DownloadedFile } from './sync';
import { InitialImportApi } from './initial-import';
import { LinksWorkerApi } from './links';
import { EncryptedFiles } from '../encryption/encrypted-files';
import type { VaultKeyBundle } from '../../encryption/key-bundle';
import { createReminderProjection } from '../../encryption/reminder-projection';
import { readServerEncryption } from '../encryption/conversion';

export { HttpError, SyncTransportError } from './http';

export class SyncApiClient {
	getEncryptionState() { return readServerEncryption(this.http); }
	async configureEncryption(bundle: VaultKeyBundle): Promise<void> {
		const encryption = await EncryptedFiles.create(this.http, bundle, (path, bytes) => createReminderProjection(bundle, path, bytes));
		this.syncApi.setEncryption(encryption);
		this.sharedHistory.setEncryption(encryption);
		this.sharedSettingsApi.setEncryption(encryption);
		this.http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
		this.linksApi.setEncryption(encryption);
	}
	readonly initialImport: InitialImportApi;
	createFileOperations(manifest: LocalManifest, vault: Vault, cache: MarkdownBaseCache) {
		return createEngineFileOperations(this.syncApi, manifest, vault, cache, this.http.getRequestDiagnostics().clientSession);
	}
	private readonly http: WorkerApiHttpClient;
	private readonly syncApi: SyncWorkerApi;
	/** Raw writes that bypass the durable upload journal and rename guards. Sync uses
	 * the engine's file operations; these serve tests and tools acting as another device. */
	readonly unjournaled: Pick<SyncWorkerApi, 'uploadFile' | 'deleteFile' | 'batchUpload' | 'batchDelete'>;
	readonly sharedHistory: SharedHistoryApi;
	private readonly authApi: AuthWorkerApi;
	private readonly sharedSettingsApi: SharedSettingsWorkerApi;
	private readonly notificationsApi: NotificationsWorkerApi;
	private readonly linksApi: LinksWorkerApi;

	constructor(workerUrl: string, authToken: string, transport?: ApiHttpTransport) {
		this.http = new WorkerApiHttpClient(workerUrl, authToken, transport);
		this.initialImport = new InitialImportApi(this.http);
		this.syncApi = new SyncWorkerApi(this.http);
		this.unjournaled = this.syncApi;
		this.sharedHistory = new SharedHistoryApi(this.http);
		this.authApi = new AuthWorkerApi(this.http);
		this.sharedSettingsApi = new SharedSettingsWorkerApi(this.http);
		this.notificationsApi = new NotificationsWorkerApi(this.http);
		this.linksApi = new LinksWorkerApi(this.http);
	}

	setAbortSignal(signal: AbortSignal): void {
		this.http.setAbortSignal(signal);
	}

	isConfigured(): boolean {
		return this.http.isConfigured();
	}

	async fetchPageTitle(url: string): Promise<string | null> {
		return this.linksApi.fetchPageTitle(url);
	}

	getWorkerUrl(): string {
		return this.http.getWorkerUrl();
	}

	resetRequestTimings(): void { this.http.resetRequestTimings(); }
	getRequestTimings() { return this.http.getRequestTimings(); }
	getRequestDiagnostics(): RequestDiagnostics {
		return this.http.getRequestDiagnostics();
	}

	async health(): Promise<HealthResponse> {
		return this.syncApi.health();
	}

	async getServerInfo(): Promise<CrateServerInfo> {
		return this.syncApi.getServerInfo();
	}

	async testConnection(): Promise<ConnectionTestResult> {
		return this.syncApi.testConnection();
	}

	async getDiagnostics(): Promise<BackendDiagnostics> {
		return this.syncApi.getDiagnostics();
	}

	async getManifest(): Promise<FileManifest> {
		return this.syncApi.getManifest();
	}

	async getFileMetadata(paths: string[]): Promise<FileMetadataResponse> {
		return this.syncApi.getFileMetadata(paths);
	}

	async downloadFile(path: string): Promise<DownloadedFile> {
		return this.syncApi.downloadFile(path);
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return this.syncApi.checkForChanges(since);
	}

	async getChanges(since: number): Promise<ChangesResponse> {
		return this.syncApi.getChanges(since);
	}

	async batchDownload(paths: string[]): Promise<DownloadedBatch> {
		return this.syncApi.batchDownload(paths);
	}

	async previewFileVersion(version: RemoteFileVersion): Promise<ArrayBuffer> {
		return this.syncApi.previewFileVersion(version);
	}

	async listFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		return this.syncApi.listFileVersions(query);
	}

	async revokeToken(id: string): Promise<{ success: boolean }> {
		return this.authApi.revokeToken(id);
	}

	async revokeCurrentToken(): Promise<{ success: boolean }> {
		return this.authApi.revokeCurrentToken();
	}

	async listTokens(): Promise<{ tokens: RegisteredDevice[] }> {
		return this.authApi.listTokens();
	}

	async getSharedSettings(): Promise<{ settings: SharedSettings | null; settingsVersion: string | null }> {
		return this.sharedSettingsApi.getSharedSettings();
	}

	/** The server's shared settings as this client last read or wrote them, read first when unknown. */
	async getKnownSharedSettings(): Promise<VersionedSharedSettings> {
		return this.sharedSettingsApi.getKnownSharedSettings();
	}

	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		return this.sharedSettingsApi.putSharedSettings(settings);
	}

	async createSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		return this.sharedSettingsApi.createSharedSettings(settings);
	}

	async ensureNotificationPolicy(policy: Omit<NotificationPolicy, 'revision'>): Promise<{ policy: NotificationPolicy }> {
		return this.notificationsApi.ensureNotificationPolicy(policy);
	}

	async getNotificationPolicy(): Promise<{ policy: NotificationPolicy | null }> {
		return this.notificationsApi.getNotificationPolicy();
	}

	async updateNotificationPolicy(policy: NotificationPolicy): Promise<{ policy: NotificationPolicy }> {
		return this.notificationsApi.updateNotificationPolicy(policy);
	}

	async getPushSubscriptions(): Promise<PushSubscriptionsResponse> {
		return this.notificationsApi.getPushSubscriptions();
	}

	async createRemindersEnrollmentToken(folderPath: string): Promise<{ token: string; browserToken: string; expiresAt: string }> {
		return this.notificationsApi.createRemindersEnrollmentToken(folderPath);
	}

	async deletePushSubscription(id: string): Promise<{ success: boolean }> {
		return this.notificationsApi.deletePushSubscription(id);
	}

	async testPush(): Promise<PushTestResponse> {
		return this.notificationsApi.testPush();
	}
}
