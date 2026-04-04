import { isRecord } from '../plugin/settings';
import type { CrateSettings, SharedSettings } from '../plugin/types';

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const normalized = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') {
			return null;
		}

		const trimmed = item.trim();
		if (trimmed.length > 0) {
			normalized.add(trimmed);
		}
	}

	return [...normalized];
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	return undefined;
}

function parseNonNegativeIntegerParam(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

type SharedSettingsTarget = Pick<
	CrateSettings,
	'ignorePatterns' | 'syncOnStartup' | 'syncInterval' | 'showStatusBar' | 'pushEnabled'
>;

export function applySharedSettings(target: SharedSettingsTarget, shared: SharedSettings): void {
	target.ignorePatterns = [...shared.ignorePatterns];
	target.syncOnStartup = shared.syncOnStartup;
	target.syncInterval = shared.syncInterval;
	target.showStatusBar = shared.showStatusBar;
	target.pushEnabled = shared.pushEnabled;
}

export function parseSharedSettingsFromSetupParams(
	params: Record<string, string>,
): Partial<SharedSettings> {
	const update: Partial<SharedSettings> = {};

	if (params['ignorePatterns']) {
		try {
			const parsed = JSON.parse(params['ignorePatterns']) as unknown;
			const ignorePatterns = normalizeStringArray(parsed);
			if (ignorePatterns) {
				update.ignorePatterns = ignorePatterns;
			}
		} catch {
			// Keep existing ignore patterns when parsing fails.
		}
	}

	const syncOnStartup = parseBooleanParam(params['syncOnStartup']);
	if (syncOnStartup !== undefined) {
		update.syncOnStartup = syncOnStartup;
	}

	const syncInterval = parseNonNegativeIntegerParam(params['syncInterval']);
	if (syncInterval !== undefined) {
		update.syncInterval = syncInterval;
	}

	const showStatusBar = parseBooleanParam(params['showStatusBar']);
	if (showStatusBar !== undefined) {
		update.showStatusBar = showStatusBar;
	}

	const pushEnabled = parseBooleanParam(params['pushEnabled']);
	if (pushEnabled !== undefined) {
		update.pushEnabled = pushEnabled;
	}

	return update;
}

export function normalizeSharedSettingsValue(value: unknown): SharedSettings | null {
	if (!isRecord(value)) {
		return null;
	}

	const ignorePatterns = normalizeStringArray(value.ignorePatterns);
	const syncInterval = typeof value.syncInterval === 'number' && Number.isInteger(value.syncInterval) && value.syncInterval >= 0
		? value.syncInterval
		: null;
	const pushEnabled = typeof value.pushEnabled === 'boolean' ? value.pushEnabled : false;
	if (
		ignorePatterns === null ||
		typeof value.syncOnStartup !== 'boolean' ||
		syncInterval === null ||
		typeof value.showStatusBar !== 'boolean'
	) {
		return null;
	}

	return {
		ignorePatterns,
		syncOnStartup: value.syncOnStartup,
		syncInterval,
		showStatusBar: value.showStatusBar,
		pushEnabled,
	};
}
