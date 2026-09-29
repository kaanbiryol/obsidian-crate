import { pwaSyncState } from '../sync/state';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { fetchPwaAssetVersion } from '../api';
import { usePwaUpdate } from '../hooks/usePwaUpdate';
import { useToast } from '../hooks/useToast';
import { PwaToast } from './PwaToast';
import { useSettingsOpen, useSettingsStore } from '../settings-context';
import { startUpdateChecks } from '../update-checker';
import type { CrateSection } from './FeatureSwitcherButton';
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
	const models = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const [version, setVersion] = useState<string | null>(null);
	const [checkComplete, setCheckComplete] = useState(false);
	const [online, setOnline] = useState(() => navigator.onLine);
	useEffect(() => {
		const changed = () => setOnline(navigator.onLine);
		window.addEventListener('online', changed); window.addEventListener('offline', changed);
		return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
	}, []);
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
	const { updating, update, launchPending } = usePwaUpdate(showToast, Boolean(models[activeSection]?.updateContentReady ?? models[activeSection]?.ready), {
		version, checkComplete,
		// Preserve automatic updates behind the Reminders launch splash only.
		canApply: () => activeSection === 'reminders' && Boolean(store.getSnapshot().reminders?.connected) && !store.getOpen() && canApply(),
		canManuallyApply: canApply,
	});
	const blockedReason = !online ? 'Connect to the internet to update.'
		: !pwaSyncState(models).ready ? 'Checking saved changes…'
		: !pwaSyncState(models).canUpdate ? 'Finish editing or syncing before updating.' : null;
	const value = useMemo(() => ({ version, updating, update, launchPending, blockedReason, feedback: toast }), [version, updating, update, launchPending, blockedReason, toast]);
	return <UpdateContext.Provider value={value}>
		{children}
		<div className="crate-reminders-ui"><PwaToast toast={settingsOpen ? null : toast} /></div>
	</UpdateContext.Provider>;
}
