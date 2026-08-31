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
	RemoteFileVersion,
	SharedSettings,
	UploadResult,
} from '../plugin/types';
import type { CrateServerInfo } from '../protocol';
import { AuthWorkerApi } from './worker-api/auth';
import { WorkerApiHttpClient } from './worker-api/http';
import type { ApiHttpTransport } from './worker-api/http';
import type {
	PushSubscriptionsResponse,
	PushTestResponse,
	ReminderScheduleRequest,
	ScheduledReminderResponse,
} from './worker-api/notifications';
import { NotificationsWorkerApi } from './worker-api/notifications';
import { SharedSettingsWorkerApi } from './worker-api/shared-settings';
import { SyncWorkerApi } from './worker-api/sync';

export { HttpError } from './worker-api/http';

export class SyncApiClient {
	private readonly http: WorkerApiHttpClient;
	private readonly syncApi: SyncWorkerApi;
	private readonly authApi: AuthWorkerApi;
	private readonly sharedSettingsApi: SharedSettingsWorkerApi;
	private readonly notificationsApi: NotificationsWorkerApi;

	constructor(workerUrl: string, authToken: string, transport?: ApiHttpTransport) {
		this.http = new WorkerApiHttpClient(workerUrl, authToken, transport);
		this.syncApi = new SyncWorkerApi(this.http);
		this.authApi = new AuthWorkerApi(this.http);
		this.sharedSettingsApi = new SharedSettingsWorkerApi(this.http);
		this.notificationsApi = new NotificationsWorkerApi(this.http);
	}

	setAbortSignal(signal: AbortSignal): void {
		this.http.setAbortSignal(signal);
	}

	updateCredentials(workerUrl: string, authToken: string): void {
		this.http.updateCredentials(workerUrl, authToken);
	}

	isConfigured(): boolean {
		return this.http.isConfigured();
	}

	getWorkerUrl(): string {
		return this.http.getWorkerUrl();
	}

	async health(): Promise<HealthResponse> {
		return this.syncApi.health();
	}

	async getServerInfo(): Promise<CrateServerInfo> {
		return this.syncApi.getServerInfo();
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
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

	async uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
		expectedHash: string | null,
	): Promise<UploadResult> {
		return this.syncApi.uploadFile(path, content, hash, size, contentType, expectedHash);
	}

	async downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number; hash: string }> {
		return this.syncApi.downloadFile(path);
	}

	async deleteFile(path: string, expectedHash: string): Promise<{ success: boolean; path: string }> {
		return this.syncApi.deleteFile(path, expectedHash);
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
	): Promise<BatchDeleteResponse> {
		return this.syncApi.batchDelete(paths, expectedHashes);
	}

	async listFileVersions(path?: string): Promise<{ versions: RemoteFileVersion[] }> {
		return this.syncApi.listFileVersions(path);
	}

	async restoreFileVersion(
		storageKey: string,
		expectedHash: string | null,
	): Promise<{ success: boolean; path: string; hash: string; size: number }> {
		return this.syncApi.restoreFileVersion(storageKey, expectedHash);
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

	async scheduleReminder(data: ReminderScheduleRequest): Promise<{ success: boolean }> {
		return this.notificationsApi.scheduleReminder(data);
	}

	async cancelReminder(reminderId: string): Promise<{ success: boolean }> {
		return this.notificationsApi.cancelReminder(reminderId);
	}

	async getScheduledReminders(): Promise<ScheduledReminderResponse> {
		return this.notificationsApi.getScheduledReminders();
	}

	async getPushSubscriptions(): Promise<PushSubscriptionsResponse> {
		return this.notificationsApi.getPushSubscriptions();
	}

	async createPushEnrollmentToken(): Promise<{ token: string; expiresAt: string }> {
		return this.notificationsApi.createPushEnrollmentToken();
	}

	async createRemindersEnrollmentToken(): Promise<{ token: string; browserToken?: string; expiresAt: string }> {
		return this.notificationsApi.createRemindersEnrollmentToken();
	}

	async deletePushSubscription(id: string): Promise<{ success: boolean }> {
		return this.notificationsApi.deletePushSubscription(id);
	}

	async testPush(): Promise<PushTestResponse> {
		return this.notificationsApi.testPush();
	}
}
