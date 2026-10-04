import { useSyncExternalStore } from 'react';
import { useSettingsStore } from '../settings-context';
import { PwaSyncStatusIndicator } from '../components/PwaSyncStatusIndicator';
import { pwaSyncState } from './state';
import { useSyncFeedback } from './SyncFeedback';

export function AppSyncIndicator() {
	const store = useSettingsStore();
	const showToast = useSyncFeedback();
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	return <PwaSyncStatusIndicator {...pwaSyncState(snapshot).status} onShowStatus={(label, state) =>
		showToast(state === 'error' ? 'error' : state === 'synced' ? 'success' : 'info', label, state)} />;
}
