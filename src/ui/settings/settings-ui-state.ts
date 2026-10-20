import type { RegisteredDevice } from '../../protocol/sync-types';
import type { SyncApiClient } from '../../sync/api';
import type { DiagnosticResult } from '../../sync/diagnostics/checks';
import type { CrateSettings } from '../../plugin/settings-types';

interface CachedDiagnosticsState {
	key: string;
	results: DiagnosticResult[];
}

export interface CachedDevicesState {
	client: SyncApiClient;
	tokens: RegisteredDevice[] | null;
	pending: Promise<void> | null;
}

export interface SettingsUiState {
	devices: CachedDevicesState | null;
	diagnostics: CachedDiagnosticsState | null;
}

export function createSettingsUiState(): SettingsUiState {
	return {
		diagnostics: null,
		devices: null,
	};
}

export function buildDiagnosticsSettingsStateKey(
	settings: Pick<CrateSettings, 'workerUrl'>
): string {
	return settings.workerUrl;
}
