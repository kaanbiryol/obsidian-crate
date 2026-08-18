import type { DiagnosticResult } from '../sync/diagnostics';
import type { CrateSettings } from './types';

interface CachedDiagnosticsState {
	key: string;
	results: DiagnosticResult[];
}

export interface SettingsUiState {
	diagnostics: CachedDiagnosticsState | null;
}

export function createSettingsUiState(): SettingsUiState {
	return {
		diagnostics: null,
	};
}

export function buildDiagnosticsSettingsStateKey(
	settings: Pick<CrateSettings, 'workerUrl'>
): string {
	return settings.workerUrl;
}
