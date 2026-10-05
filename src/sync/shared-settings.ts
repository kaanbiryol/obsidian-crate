import type { CrateSettings } from '../plugin/settings-types';
import type { SharedSettings } from '../protocol/shared-settings';

type SharedSettingsTarget = Pick<
	CrateSettings,
	'ignorePatterns' | 'syncOnStartup' | 'syncOnResume' | 'syncInterval' | 'pushEnabled'
>;

export function applySharedSettings(target: SharedSettingsTarget, shared: SharedSettings): void {
	target.ignorePatterns = [...shared.ignorePatterns];
	target.syncOnStartup = shared.syncOnStartup;
	target.syncOnResume = shared.syncOnResume;
	target.syncInterval = shared.syncInterval;
	target.pushEnabled = shared.pushEnabled;
}
