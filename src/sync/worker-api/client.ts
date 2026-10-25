import type { ConnectionTestResult } from '../types';
import { SharedHistoryApi } from './history-checkpoints';
import type { RequestDiagnostics } from '../diagnostics/request-diagnostics';
import type { NotificationPolicy } from '../../protocol/notification-policy';
import type { WireStore } from '../encryption/path-index';
/**
 * Worker API client facade for sync, setup, and reminder endpoints.
 */

import type {
	BackendDiagnostics,
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
import { SyncWorkerApi, type ChangesPage, type DownloadedBatch, type DownloadedFile } from './sync';
import { InitialImportApi } from './initial-import';
import { LinksWorkerApi } from './links';
import { EncryptedFiles } from '../encryption/encrypted-files';
import type { VaultKeyBundle } from '../../encryption/key-bundle';
import { createReminderProjection, importNotificationKeys } from '../../encryption/reminder-projection';
import { readServerEncryption } from '../encryption/server-encryption';
import { importEncryptionSecret, type EncryptionKey } from '../../encryption/envelope';
import type { PathTags } from '../../encryption/path-tags';
import { openFolderLabel, sealFolderLabel } from '../../encryption/folder-label';

export { HttpError, SyncTransportError } from './http';

export class SyncApiClient {
	getEncryptionState() { return readServerEncryption(this.http); }
	/** Notes inside `reminderFolders()` carry encrypted notification schedules; notes the
	 * server sealed to the vault are accepted only inside `readingFolder()`. */
	async configureEncryption(bundle: VaultKeyBundle, reminderFolders: () => readonly string[], readingFolder?: () => string | null): Promise<void> {
		const notifications = await importNotificationKeys(bundle.vaultId, bundle.notifications);
		const encryption = await EncryptedFiles.create(this.http, bundle, (path, bytes) => createReminderProjection(notifications, reminderFolders(), path, bytes), readingFolder);
		this.syncApi.setEncryption(encryption);
		this.sharedHistory.setEncryption(encryption);
		this.sharedSettingsApi.setEncryption(encryption);
		this.http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
		this.linksApi.setEncryption(encryption);
		this.folderKeys = { tags: encryption.paths.tags, key: await importEncryptionSecret(bundle.vault), vaultId: bundle.vaultId };
	}
	private folderKeys?: { tags: PathTags; key: EncryptionKey; vaultId: string };

	/** A feature folder as the server stores it: in an encrypted vault, its tag and sealed name. */
	async serverFolder(path: string): Promise<{ folderPath: string; folderLabel?: string }> {
		if (!this.folderKeys) return { folderPath: path };
		const { wire, label } = await sealFolderLabel(path, this.folderKeys.tags, this.folderKeys.key, this.folderKeys.vaultId);
		return { folderPath: wire, folderLabel: label };
	}

	/** The plaintext folder a server policy names. */
	async localFolder(folderPath: string, folderLabel: string | undefined): Promise<string> {
		if (!this.folderKeys) return folderPath;
		if (!folderLabel) throw new Error('The server did not return this folder\'s encrypted name. Update the Crate server.');
		return openFolderLabel(folderPath, folderLabel, this.folderKeys.tags, this.folderKeys.key, this.folderKeys.vaultId);
	}

	private async localPolicy(policy: NotificationPolicy): Promise<NotificationPolicy> {
		const { folderLabel, ...rest } = policy;
		return { ...rest, folderPath: await this.localFolder(policy.folderPath, folderLabel) };
	}

	readonly initialImport: InitialImportApi;
	/** What the engine's journaled file operations wrap. Sync writes go through those
	 * operations, never through this transport directly. `store` maps encrypted paths. */
	getFileTransport(store: WireStore): { readonly transport: SyncWorkerApi; readonly clientSession: string } {
		this.syncApi.useWireStore(store);
		return { transport: this.syncApi, clientSession: this.http.getRequestDiagnostics().clientSession };
	}
	private readonly http: WorkerApiHttpClient;
	private readonly syncApi: SyncWorkerApi;
	/** Raw writes that bypass the durable upload journal and rename guards. Sync uses
	 * the engine's file operations; these serve tests and tools acting as another device. */
	readonly unjournaled: Pick<SyncWorkerApi, 'uploadFile' | 'batchUpload' | 'batchDelete'>;
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

	async getChanges(since: number): Promise<ChangesPage> {
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
		const result = await this.notificationsApi.ensureNotificationPolicy({ ...policy, ...await this.serverFolder(policy.folderPath) });
		return { policy: await this.localPolicy(result.policy) };
	}

	async getNotificationPolicy(): Promise<{ policy: NotificationPolicy | null }> {
		const { policy } = await this.notificationsApi.getNotificationPolicy();
		return { policy: policy && await this.localPolicy(policy) };
	}

	async updateNotificationPolicy(policy: NotificationPolicy): Promise<{ policy: NotificationPolicy }> {
		const result = await this.notificationsApi.updateNotificationPolicy({ ...policy, ...await this.serverFolder(policy.folderPath) });
		return { policy: await this.localPolicy(result.policy) };
	}

	async getPushSubscriptions(): Promise<PushSubscriptionsResponse> {
		return this.notificationsApi.getPushSubscriptions();
	}

	async createRemindersEnrollmentToken(folderPath: string): Promise<{ token: string; browserToken: string; expiresAt: string }> {
		return this.notificationsApi.createRemindersEnrollmentToken(await this.serverFolder(folderPath));
	}

	async deletePushSubscription(id: string): Promise<{ success: boolean }> {
		return this.notificationsApi.deletePushSubscription(id);
	}

	async testPush(): Promise<PushTestResponse> {
		return this.notificationsApi.testPush();
	}
}
