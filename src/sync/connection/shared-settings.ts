import type { SharedSettings } from '../../protocol/shared-settings';
import type { SyncSettings } from '../settings';

type SharedSettingsTarget = Pick<
	SyncSettings,
	'ignorePatterns' | 'syncInterval' | 'pushEnabled'
>;

/** Settings replicated to other devices; apply is the inverse of build. */
export function buildSharedSettings(settings: SharedSettingsTarget): SharedSettings {
	return {
		ignorePatterns: settings.ignorePatterns,
		syncInterval: settings.syncInterval,
		pushEnabled: settings.pushEnabled,
	};
}

export function applySharedSettings(target: SharedSettingsTarget, shared: SharedSettings): void {
	target.ignorePatterns = [...shared.ignorePatterns];
	target.syncInterval = shared.syncInterval;
	target.pushEnabled = shared.pushEnabled;
}
