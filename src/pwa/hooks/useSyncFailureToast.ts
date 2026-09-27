import { useContext, useEffect, useRef } from 'react';
import { FeatureNavigationContext } from '../components/FeatureSwitcherButton';
import type { ShowToast } from '../types';

/** Announce actionable failures once; persistent sync notices own recovery. */
export function useSyncFailureToast({ scope, ready, operationIds, feature, showToast, isCurrent }: {
	scope: string | null;
	ready: boolean;
	operationIds: string[];
	feature: 'Reading' | 'Reminder';
	showToast: ShowToast;
	isCurrent?: () => boolean;
}) {
	const active = useContext(FeatureNavigationContext)?.active !== false;
	const announced = useRef<{ scope: string | null; ids: Set<string> }>({ scope: null, ids: new Set() });
	useEffect(() => {
		if (announced.current.scope !== scope) announced.current = { scope, ids: new Set() };
		if (!scope || !ready || !active) return;
		const announce = () => {
			if (document.visibilityState === 'hidden' || isCurrent && !isCurrent()) return;
			const unseen = operationIds.filter(id => !announced.current.ids.has(id));
			if (!unseen.length) return;
			unseen.forEach(id => announced.current.ids.add(id));
			showToast('error', `${feature} changes need attention. Review them in settings.`);
		};
		announce();
		document.addEventListener('visibilitychange', announce);
		return () => document.removeEventListener('visibilitychange', announce);
	}, [scope, ready, active, operationIds, feature, showToast, isCurrent]);
}
