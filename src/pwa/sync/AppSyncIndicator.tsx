import { useSyncExternalStore } from 'react';
import { useSettingsStore } from '../settings-context';
import { PwaSyncStatusIndicator } from '../components/PwaSyncStatusIndicator';
import { pwaSyncState } from './state';

export function AppSyncIndicator() {
	const store = useSettingsStore();
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	return <PwaSyncStatusIndicator {...pwaSyncState(snapshot).status} onShowStatus={store.openSync} />;
}
