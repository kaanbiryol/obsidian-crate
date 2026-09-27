import { createContext, useContext, useEffect, useMemo, useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { fetchPwaAssetVersion } from '../api';
import { usePwaUpdate } from '../hooks/usePwaUpdate';
import { useToast } from '../hooks/useToast';
import { useSettingsStore } from '../settings-context';
import { startUpdateChecks } from '../update-checker';
import type { CrateSection } from './FeatureSwitcherButton';
import { PwaToast } from './PwaToast';
import { PwaUpdateNotice } from './PwaUpdateNotice';

interface AppUpdate {
	version: string | null;
	updating: boolean;
	launchPending: boolean;
	dismissed: boolean;
	dismiss: () => void;
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
	const models = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const [version, setVersion] = useState<string | null>(null);
	const [checkComplete, setCheckComplete] = useState(false);
	const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
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
			&& Boolean(current[activeSection]?.ready)
			&& [current.reminders, current.reading].every(model => !model || (model.ready && !model.unsynced && model.updateReady !== false))
			&& !document.querySelector('.pwa-modal-sheet--reminder, .pwa-reading-sheet, [role="alertdialog"]');
	};
	const { updating, update, launchPending } = usePwaUpdate(showToast, Boolean(models[activeSection]?.updateContentReady ?? models[activeSection]?.ready), {
		version, checkComplete,
		// Preserve automatic updates behind the Reminders launch splash only.
		canApply: () => activeSection === 'reminders' && Boolean(store.getSnapshot().reminders?.connected) && !store.getOpen() && canApply(),
		canManuallyApply: canApply,
	});
	const dismissed = version === dismissedVersion;
	const dismiss = useCallback(() => setDismissedVersion(version), [version]);
	const value = useMemo(() => ({ version, updating, update, launchPending, dismissed, dismiss }), [version, updating, update, launchPending, dismissed, dismiss]);
	return <UpdateContext.Provider value={value}>
		{children}
		<div className="crate-reminders-ui pwa-update-floating" hidden={models.open || launchPending}>
			{!launchPending && <PwaUpdateNotice />}
		</div>
		<div className="crate-reminders-ui pwa-update-feedback"><PwaToast toast={toast} /></div>
	</UpdateContext.Provider>;
}
