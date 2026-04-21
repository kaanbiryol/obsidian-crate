import type { DiagnosticResult } from '../cloudflare/infrastructure-types';
import type { CrateSettings, UsageResponse } from './types';

export interface CachedUsageState {
	key: string;
	data: UsageResponse;
}

export interface CachedDiagnosticsState {
	key: string;
	results: DiagnosticResult[];
}

export interface SettingsUiState {
	usage: CachedUsageState | null;
	diagnostics: CachedDiagnosticsState | null;
}

export function createSettingsUiState(): SettingsUiState {
	return {
		usage: null,
		diagnostics: null,
	};
}

export function buildUsageSettingsStateKey(
	settings: Pick<CrateSettings, 'cloudflareAccountId' | 'workerName' | 'bucketName' | 'databaseId'>
): string {
	return JSON.stringify([
		settings.cloudflareAccountId,
		settings.workerName,
		settings.bucketName,
		settings.databaseId,
	]);
}

export function buildDiagnosticsSettingsStateKey(
	settings: Pick<CrateSettings, 'cloudflareAccountId' | 'workerUrl' | 'workerName' | 'bucketName' | 'databaseId'>
): string {
	return JSON.stringify([
		settings.cloudflareAccountId,
		settings.workerUrl,
		settings.workerName,
		settings.bucketName,
		settings.databaseId,
	]);
}
