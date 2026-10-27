import type { RegisteredDevice } from '../protocol/sync-types';
import type { SyncApiClient } from '../sync/worker-api/client';
import type { DiagnosticResult } from '../sync/diagnostics/checks';
import type { EncryptionServerState } from '../encryption/server-state';
import type { NotificationPolicy } from '../protocol/notification-policy';
import type { CrateSettings } from './settings-types';

interface CachedDiagnosticsState {
	key: string;
	results: DiagnosticResult[];
}

export interface CachedDevicesState {
	client: SyncApiClient;
	tokens: RegisteredDevice[] | null;
	pending: Promise<void> | null;
}

/** A request shared by re-renders while the settings tab stays open; hiding the tab clears it. */
interface CachedSettingsRequest<T> {
	client: SyncApiClient;
	value: Promise<T>;
}

export interface SettingsUiState {
	devices: CachedDevicesState | null;
	diagnostics: CachedDiagnosticsState | null;
	encryptionStatus: CachedSettingsRequest<EncryptionServerState | null> | null;
	/** Changing the reminders folder also updates the server's policy. */
	notificationPolicy: (CachedSettingsRequest<NotificationPolicy | null> & { folderPath: string }) | null;
}

export function createSettingsUiState(): SettingsUiState {
	return {
		diagnostics: null,
		devices: null,
		encryptionStatus: null,
		notificationPolicy: null,
	};
}

export function buildDiagnosticsSettingsStateKey(
	settings: Pick<CrateSettings, 'workerUrl'>
): string {
	return settings.workerUrl;
}
