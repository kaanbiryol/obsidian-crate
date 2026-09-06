import { isRecord } from '../plugin/settings';
import { type CrateSettings, type SharedSettings } from '../plugin/settings-types';

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

type SharedSettingsTarget = Pick<
	CrateSettings,
	'ignorePatterns' | 'syncOnStartup' | 'syncOnResume' | 'syncInterval' | 'showStatusBar' | 'pushEnabled'
>;

export function applySharedSettings(target: SharedSettingsTarget, shared: SharedSettings): void {
	target.ignorePatterns = [...shared.ignorePatterns];
	target.syncOnStartup = shared.syncOnStartup;
	target.syncOnResume = shared.syncOnResume;
	target.syncInterval = shared.syncInterval;
	target.showStatusBar = shared.showStatusBar;
	target.pushEnabled = shared.pushEnabled;
}

export function normalizeSharedSettingsValue(value: unknown): SharedSettings | null {
	if (!isRecord(value)) {
		return null;
	}

	const ignorePatterns = normalizeStringArray(value.ignorePatterns);
	const syncInterval = typeof value.syncInterval === 'number' && Number.isInteger(value.syncInterval) && value.syncInterval >= 0
		? value.syncInterval
		: null;
	if (
		ignorePatterns === null ||
		typeof value.syncOnStartup !== 'boolean' ||
		typeof value.syncOnResume !== 'boolean' ||
		typeof value.pushEnabled !== 'boolean' ||
		syncInterval === null ||
		typeof value.showStatusBar !== 'boolean'
	) {
		return null;
	}

	return {
		ignorePatterns,
		syncOnStartup: value.syncOnStartup,
		syncOnResume: value.syncOnResume,
		syncInterval,
		showStatusBar: value.showStatusBar,
		pushEnabled: value.pushEnabled,
	};
}
