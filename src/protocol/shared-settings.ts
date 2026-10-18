import { isRecord } from '../platform/validation';

export interface SharedSettings {
	ignorePatterns: string[];
	syncInterval: number;
	pushEnabled: boolean;
}

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
		? value.syncInterval
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
