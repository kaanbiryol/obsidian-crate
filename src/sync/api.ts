import { createEngineFileOperations } from './engine-file-operations';
import type { ConnectionTestResult } from './types';
import { SharedHistoryApi } from './worker-api/history-checkpoints';
import type { RequestDiagnostics } from './request-diagnostics';
import type { MarkdownBaseCache } from './markdown-base-cache';
import { normalizeWorkerUrl } from './worker-url';
import type { Vault } from 'obsidian';
import type { LocalManifest } from './manifest';
import type { NotificationPolicy } from '../protocol/notification-policy';
/**
 * Worker API client facade for sync, setup, and reminder endpoints.
 */

import type {
	BatchDeleteResponse,
	BatchDownloadResponse,
	BatchUploadFile,
	BatchUploadResponse,
	BackendDiagnostics,
	ChangesResponse,
	CheckResponse,
	FileManifest,
	FileMetadataResponse,
	HealthResponse,
	RegisteredDevice,
	FileVersionQuery,
	FileVersionsPage,
	UploadResult,
	RemoteFileVersion,
} from '../protocol/sync-types';
import type { SharedSettings } from '../protocol/shared-settings';
import type { CrateServerInfo } from '../protocol';
import { AuthWorkerApi } from './worker-api/auth';
import { WorkerApiHttpClient } from './worker-api/http';
import type { ApiHttpTransport } from './worker-api/http';
import type {
	PushSubscriptionsResponse,
	PushTestResponse,
} from './worker-api/notifications';
import { NotificationsWorkerApi } from './worker-api/notifications';
import { SharedSettingsWorkerApi } from './worker-api/shared-settings';
import { SyncWorkerApi } from './worker-api/sync';
import { InitialImportApi } from './worker-api/initial-import';
import { EncryptedFiles } from './encrypted-files';
import type { VaultKeyBundle } from '../encryption/key-bundle';
import { createReminderProjection } from '../encryption/reminder-projection';
import { readServerEncryption } from './encryption-conversion';

export { HttpError } from './worker-api/http';

export class SyncApiClient {
	getEncryptionState() { return readServerEncryption(this.http); }
	private encryption?: EncryptedFiles;
	async configureEncryption(bundle: VaultKeyBundle): Promise<void> {
		const encryption = await EncryptedFiles.create(this.http, bundle, (path, bytes) => createReminderProjection(bundle, path, bytes));
		this.syncApi.setEncryption(encryption);
		this.sharedHistory.setEncryption(encryption);
		this.sharedSettingsApi.setEncryption(encryption);
		this.http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
		this.encryption = encryption;
	}
  readonly initialImport: InitialImportApi;
	private fileOperationAuthority?: string;
	createFileOperations(manifest: LocalManifest, vault: Vault, cache: MarkdownBaseCache) {
		this.fileOperationAuthority = this.getWorkerUrl();
		return createEngineFileOperations(this.syncApi, manifest, vault, cache, this.http.getRequestDiagnostics().clientSession);
	}
	private readonly http: WorkerApiHttpClient;
	private readonly syncApi: SyncWorkerApi;
    readonly sharedHistory: SharedHistoryApi;
	private readonly authApi: AuthWorkerApi;
	private readonly sharedSettingsApi: SharedSettingsWorkerApi;
	private readonly notificationsApi: NotificationsWorkerApi;

	constructor(workerUrl: string, authToken: string, transport?: ApiHttpTransport) {
		this.http = new WorkerApiHttpClient(workerUrl, authToken, transport);
    this.initialImport = new InitialImportApi(this.http);
		this.syncApi = new SyncWorkerApi(this.http);
        this.sharedHistory = new SharedHistoryApi(this.http);
		this.authApi = new AuthWorkerApi(this.http);
		this.sharedSettingsApi = new SharedSettingsWorkerApi(this.http);
		this.notificationsApi = new NotificationsWorkerApi(this.http);
	}

	setAbortSignal(signal: AbortSignal): void {
		this.http.setAbortSignal(signal);
	}

	updateCredentials(workerUrl: string, authToken: string): void {
		if (this.encryption) throw new Error('Reinitialize encrypted sync before changing connection credentials');
		if (this.fileOperationAuthority !== undefined && normalizeWorkerUrl(workerUrl) !== this.fileOperationAuthority) throw new Error('Stop this sync engine and preserve its pending uploads before connecting another server');
		this.http.updateCredentials(workerUrl, authToken);
	}

	isConfigured(): boolean {
		return this.http.isConfigured();
	}

	async fetchPageTitle(url: string): Promise<string | null> {
		if (this.encryption) return null;
		if (await readServerEncryption(this.http, 7000)) return null;
		const result = await this.http.requestJson<{ title?: unknown }>('/links/title', {
			method: 'POST', body: JSON.stringify({ url }),
		}, 7000);
		return typeof result.title === 'string' ? result.title : null;
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

  async retryPausedNotifications(): Promise<{ retried: number; more: boolean }> {
    return this.http.requestJson('/notifications/retry', { method: 'POST' });
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

	async uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
		expectedHash: string | null,
		operationId?: string,
	): Promise<UploadResult> {
		return this.syncApi.uploadFile(path, content, hash, size, contentType, expectedHash, operationId);
	}

	async downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number; hash: string; revision?: string }> {
		return this.syncApi.downloadFile(path);
	}

	async deleteFile(path: string, expectedHash: string, expectedRevision?: string): Promise<{ success: boolean; path: string }> {
		return this.syncApi.deleteFile(path, expectedHash, expectedRevision);
	}

	async checkForChanges(since: number): Promise<CheckResponse> {
		return this.syncApi.checkForChanges(since);
	}

	async getChanges(since: number): Promise<ChangesResponse> {
		return this.syncApi.getChanges(since);
	}

	async batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse> {
		return this.syncApi.batchUpload(files);
	}

	async batchDownload(paths: string[]): Promise<BatchDownloadResponse> {
		return this.syncApi.batchDownload(paths);
	}

	async batchDelete(
		paths: string[],
		expectedHashes?: Record<string, string>,
		expectedRevisions?: Record<string, string>,
	): Promise<BatchDeleteResponse> {
		return this.syncApi.batchDelete(paths, expectedHashes, expectedRevisions);
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

	async putSharedSettings(settings: SharedSettings): Promise<{ success: boolean; settingsVersion: string }> {
		return this.sharedSettingsApi.putSharedSettings(settings);
	}

	async ensureNotificationPolicy(policy: Omit<NotificationPolicy, 'revision'>): Promise<{ policy: NotificationPolicy }> {
		return this.http.requestJson('/reminders/notification-policy', { method: 'POST', body: JSON.stringify(policy) });
	}
	async getNotificationPolicy(): Promise<{ policy: NotificationPolicy | null }> {
		return this.http.requestJson('/reminders/notification-policy');
	}
	async updateNotificationPolicy(policy: NotificationPolicy): Promise<{ policy: NotificationPolicy }> {
		return this.http.requestJson('/reminders/notification-policy', { method: 'PUT', body: JSON.stringify({ ...policy, expectedRevision: policy.revision }) });
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
