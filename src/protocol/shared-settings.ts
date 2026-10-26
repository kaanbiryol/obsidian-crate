import { isRecord } from '../platform/validation';

export interface SharedSettings {
	ignorePatterns: string[];
	syncInterval: number;
	pushEnabled: boolean;
}

/** Browser timers use signed 32-bit milliseconds; a longer delay fires immediately. */
export const MAX_SYNC_INTERVAL_SECONDS = Math.floor(2_147_483_647 / 1000);

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

export function normalizeSharedSettingsValue(value: unknown): SharedSettings | null {
	if (!isRecord(value)) {
		return null;
	}

	const ignorePatterns = normalizeStringArray(value.ignorePatterns);
	const syncInterval = typeof value.syncInterval === 'number' && Number.isInteger(value.syncInterval) && value.syncInterval >= 0
		? Math.min(value.syncInterval, MAX_SYNC_INTERVAL_SECONDS)
		: null;
	if (
		ignorePatterns === null ||
		typeof value.pushEnabled !== 'boolean' ||
		syncInterval === null
	) {
		return null;
	}

	return {
		ignorePatterns,
		syncInterval,
		pushEnabled: value.pushEnabled,
	};
}
