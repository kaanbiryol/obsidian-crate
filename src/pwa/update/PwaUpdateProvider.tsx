import { pwaSyncState } from '../sync/state';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PWA_ASSET_VERSION } from '@/pwa/shell/version';
import { usePwaUpdate } from './usePwaUpdate';
import { useToast } from '../hooks/useToast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { PwaToast } from '../components/PwaToast';
import { useSettingsOpen, useSettingsSelector, useSettingsStore } from '../settings/settings-context';
import { shallowEqual } from '../settings/settings-store';
import { startUpdateChecks, fetchPwaAssetVersion } from './update-checker';
import type { CrateSection } from '../navigation/feature-navigation';
import type { ToastState } from '../types';

interface AppUpdate {
	feedback: ToastState | null;
	blockedReason: string | null;
	version: string | null;
	updating: boolean;
	launchPending: boolean;
	update: () => Promise<void>;
}
const UpdateContext = createContext<AppUpdate | null>(null);

export function useAppUpdate() {
	const value = useContext(UpdateContext);
	if (!value) throw new Error('Updates must be mounted inside the feature shell');
	return value;
}

export function PwaUpdateProvider({ activeSection, children }: { activeSection: CrateSection; children: ReactNode }) {
	const store = useSettingsStore();
	const [settingsOpen] = useSettingsOpen();
	const sync = useSettingsSelector(snapshot => {
		const { ready, canUpdate, updateBlocked } = pwaSyncState(snapshot);
		const model = snapshot[activeSection];
		return { ready, canUpdate, updateBlocked, contentReady: Boolean(model?.updateContentReady ?? model?.ready) };
	}, shallowEqual);
	const [version, setVersion] = useState<string | null>(null);
	const [checkComplete, setCheckComplete] = useState(false);
	const online = useOnlineStatus();
	const { toast, showToast } = useToast();
	useEffect(() => {
		let active = true;
		const stop = startUpdateChecks(async () => {
			try {
				const next = await fetchPwaAssetVersion();
				if (active && next) setVersion(next === PWA_ASSET_VERSION ? null : next);
			} finally { if (active) setCheckComplete(true); }
		});
		return () => { active = false; stop(); };
	}, []);
	const canApply = () => {
		const current = store.getSnapshot();
		return navigator.onLine && document.visibilityState === 'visible'
			&& pwaSyncState(current).canUpdate
			&& !document.querySelector('.pwa-modal-sheet--reminder, .pwa-reading-sheet, [role="alertdialog"]');
	};
	const { updating, update: apply, launchPending } = usePwaUpdate(showToast, sync.contentReady, {
		version, checkComplete,
		// Preserve automatic updates behind the Reminders launch splash only.
		canApply: () => activeSection === 'reminders' && Boolean(store.getSnapshot().reminders?.connected) && !store.getOpen() && canApply(),
		blocked: sync.updateBlocked,
		canManuallyApply: canApply,
	});
	const blockedReason = !online ? 'Connect to the internet to update.'
		: !sync.ready ? 'Checking saved changes…'
		: !sync.canUpdate ? 'Finish editing or syncing before updating.' : null;
	// Touch devices never show the button's title, so a blocked tap says why in a toast.
	const update = useCallback(async () => {
		if (blockedReason) showToast('info', blockedReason);
		else await apply();
	}, [blockedReason, showToast, apply]);
	const value = useMemo(() => ({ version, updating, update, launchPending, blockedReason, feedback: toast }), [version, updating, update, launchPending, blockedReason, toast]);
	return <UpdateContext.Provider value={value}>
		{children}
		<div className="crate-reminders-ui"><PwaToast toast={settingsOpen ? null : toast} /></div>
	</UpdateContext.Provider>;
}
