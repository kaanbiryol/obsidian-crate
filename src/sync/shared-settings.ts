import type { SharedSettings } from '../protocol/shared-settings';
import type { SyncSettings } from './settings';

type SharedSettingsTarget = Pick<
	SyncSettings,
	'ignorePatterns' | 'syncInterval' | 'pushEnabled'
>;

export function applySharedSettings(target: SharedSettingsTarget, shared: SharedSettings): void {
	target.ignorePatterns = [...shared.ignorePatterns];
	target.syncInterval = shared.syncInterval;
	target.pushEnabled = shared.pushEnabled;
}
