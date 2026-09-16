import { useCallback, useEffect, useRef, useState } from 'react';
import { startAutoPwaUpdate } from '../auto-update';
import { applyPwaUpdate, preparePwaUpdate } from '../apply-update';
import { advancePwaUpdateProgress, finishPwaUpdateTransition, preparePwaUpdateTransition, showPwaUpdateTransition } from '../update-transition';
import { whenUpdateLayoutSettles } from '../update-layout-readiness';
import type { ShowToast } from '../types';

const LAUNCH_UPDATE_BUDGET_MS = 2_500;

export function usePwaUpdate(showToast: ShowToast, contentReady: boolean, auto: {
	version: string | null;
	checkComplete: boolean;
	canApply: () => boolean;
}) {
	const canAutoApply = useRef(auto.canApply);
	canAutoApply.current = auto.canApply;
	const [updating, setUpdating] = useState(false);
	const inFlight = useRef(false);
	const preparedVersion = useRef<string | null>(null);
	const [launchPending, setLaunchPending] = useState(() => navigator.onLine
		&& document.visibilityState === 'visible' && document.documentElement.dataset.pwaUpdating !== 'restore');
	const launchDeadline = useRef(Date.now() + LAUNCH_UPDATE_BUDGET_MS);
	const launchOpen = useRef(launchPending);
	const finishLaunch = useCallback(() => {
		launchOpen.current = false;
		setLaunchPending(false);
	}, []);
	useEffect(() => {
		if (!launchPending) return;
		const timer = window.setTimeout(finishLaunch, Math.max(0, launchDeadline.current - Date.now()));
		const defer = () => {
			if (document.visibilityState !== 'visible' || !navigator.onLine) finishLaunch();
		};
		document.addEventListener('visibilitychange', defer);
		window.addEventListener('offline', defer);
		return () => {
			window.clearTimeout(timer);
			document.removeEventListener('visibilitychange', defer);
			window.removeEventListener('offline', defer);
		};
	}, [launchPending, finishLaunch]);
	useEffect(() => {
		if (auto.checkComplete && !auto.version) finishLaunch();
	}, [auto.checkComplete, auto.version, finishLaunch]);
	useEffect(() => {
		if (document.documentElement.dataset.pwaUpdating !== 'restore') return;
		document.getElementById('app')?.setAttribute('inert', '');
		if (!contentReady) return;
		// Data readiness can precede safe-area, viewport and notice layout updates.
		return whenUpdateLayoutSettles(() => {
			advancePwaUpdateProgress('ready');
			finishPwaUpdateTransition({ fade: true });
		});
	}, [contentReady]);

	const apply = useCallback(async (options: Parameters<typeof applyPwaUpdate>[1] = {}, showImmediately = false) => {
		if (inFlight.current) return false;
		inFlight.current = true;
		setUpdating(true);
		let reloading = false;
		try {
			if (showImmediately) showPwaUpdateTransition();
			reloading = await applyPwaUpdate(preparePwaUpdateTransition, { ...options, onStage: advancePwaUpdateProgress });
			return reloading;
		} finally {
			if (!reloading) {
				finishPwaUpdateTransition();
				inFlight.current = false;
				setUpdating(false);
			}
		}
	}, []);

	const update = useCallback(() => {
		void apply({}, true).catch((error: unknown) => {
			showToast('error', error instanceof Error ? error.message : 'Update failed. Please try again.');
		});
	}, [apply, showToast]);

	useEffect(() => {
		if (!auto.version) return;
		if (!launchPending) {
			if (preparedVersion.current !== auto.version) {
				preparedVersion.current = auto.version;
				void preparePwaUpdate(auto.version).catch(() => undefined);
			}
			return;
		}
		preparedVersion.current = auto.version;
		return startAutoPwaUpdate(auto.version,
			() => launchOpen.current && Date.now() < launchDeadline.current && canAutoApply.current(),
			(version, canApply, beforeNavigation) => apply({ version, canApply, beforeNavigation }),
			finishLaunch);
	}, [auto.version, apply, launchPending, finishLaunch]);

	return { updating, update, launchPending };
}
