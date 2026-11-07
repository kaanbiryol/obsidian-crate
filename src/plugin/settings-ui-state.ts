import type { RegisteredDevice } from '../protocol/sync-types';
import type { SyncApiClient } from '../sync/worker-api/client';
import type { DiagnosticResult } from '../sync/diagnostics/checks';
import type { EncryptionServerState } from '../encryption/server-state';
import type { NotificationPolicy } from '../protocol/notification-policy';
import type { CrateSettings } from './settings-types';
import type CratePlugin from './CratePlugin';

interface CachedDiagnosticsState {
	key: string;
	results: DiagnosticResult[];
}

interface CachedDevicesState {
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

/** Reopening settings asks the server again for its encryption status and notification policy. */
export function clearSettingsRequests(state: SettingsUiState): void {
	state.encryptionStatus = null;
	state.notificationPolicy = null;
}

/** A connection change also drops the device list and diagnostics, which describe the old server. */
export function clearSettingsUiState(state: SettingsUiState): void {
	state.diagnostics = null;
	state.devices = null;
	clearSettingsRequests(state);
}

/** This client's device list, replacing one kept for another connection. */
export function connectedDevicesCache(state: SettingsUiState, client: SyncApiClient): CachedDevicesState {
	if (state.devices?.client !== client) state.devices = { client, tokens: null, pending: null };
	return state.devices;
}

/** Lists the cache's devices again, sharing one request among callers. */
export function refreshDeviceCache(cache: CachedDevicesState): Promise<void> {
	if (!cache.pending) {
		cache.pending = cache.client.listTokens()
			.then(({ tokens }) => { cache.tokens = tokens; })
			.finally(() => { cache.pending = null; });
	}
	return cache.pending;
}

/** The connected devices for the current server, shared with the devices section while settings stay open. */
export async function loadConnectedDevices(plugin: CratePlugin): Promise<RegisteredDevice[] | null> {
	const client = plugin.syncRuntime.getApiClient();
	if (!client) return null;
	const cache = connectedDevicesCache(plugin.settingsUiState, client);
	if (cache.tokens === null) await refreshDeviceCache(cache);
	return cache.tokens;
}

type CachedRequestField = 'encryptionStatus' | 'notificationPolicy';
type CachedRequestEntry<K extends CachedRequestField> = NonNullable<SettingsUiState[K]>;

/** Reuses the request in `field` while its client and other `key` fields match; otherwise
 * starts `load` and keeps it there. A failed request is dropped, so the next render retries. */
export function cachedSettingsRequest<K extends CachedRequestField>(
	state: SettingsUiState,
	field: K,
	key: Omit<CachedRequestEntry<K>, 'value'>,
	load: () => CachedRequestEntry<K>['value'],
): CachedRequestEntry<K>['value'] {
	const cached = state[field];
	if (cached && Object.entries(key).every(([name, value]) => Reflect.get(cached, name) === value)) return cached.value;
	const entry = { ...key, value: load() } as CachedRequestEntry<K>;
	state[field] = entry;
	entry.value.catch(() => { if (state[field] === entry) state[field] = null; });
	return entry.value;
}

export function buildDiagnosticsSettingsStateKey(
	settings: Pick<CrateSettings, 'workerUrl'>
): string {
	return settings.workerUrl;
}
