import { useSettingsSelector } from '../settings/settings-context';
import { shallowEqual, type SettingsSnapshot } from '../settings/settings-store';
import { PwaSyncStatusIndicator } from '../components/PwaSyncStatusIndicator';
import { pwaSyncState } from './state';
import { useSyncFeedback } from './SyncFeedback';

const selectStatus = (snapshot: SettingsSnapshot) => pwaSyncState(snapshot).status;

export function AppSyncIndicator() {
	const showToast = useSyncFeedback();
	const status = useSettingsSelector(selectStatus, shallowEqual);
	return <PwaSyncStatusIndicator {...status} onShowStatus={(label, state) =>
		showToast(state === 'error' ? 'error' : state === 'synced' ? 'success' : 'info', label, state)} />;
}
