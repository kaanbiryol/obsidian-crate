import { useEffect, useRef } from 'react';
import type { LoadReminders } from './types';
import { FOREGROUND_REFRESH_GAP_MS, onAppResume } from '../shell/app-resume';

const PUSH_REFRESH_INTERVAL_MS = 5 * 60_000;

export function usePwaRefreshLifecycle({
	enabled = true,
	authToken,
	bootstrapped,
	hasHydratedCache,
	loadReminders,
	refreshPushState,
}: {
	enabled?: boolean;
	authToken: string | null;
	bootstrapped: boolean;
	hasHydratedCache: () => boolean;
	loadReminders: LoadReminders;
	refreshPushState: () => Promise<void>;
}) {
	const lastPushRefresh = useRef(0);

	useEffect(() => {
		if (!enabled || !bootstrapped || !authToken) return;
		lastPushRefresh.current = Date.now();
		void Promise.all([
			loadReminders({ silent: hasHydratedCache() }),
			refreshPushState().catch(() => undefined),
		]);
	}, [enabled, authToken, bootstrapped, hasHydratedCache, loadReminders, refreshPushState]);

	useEffect(() => onAppResume(reason => {
		if (!enabled || !bootstrapped || !authToken) return;
		// Reconnection must recover changes missed offline, even after a recent read.
		void loadReminders({ silent: true, maxAgeMs: reason === 'online' ? 0 : FOREGROUND_REFRESH_GAP_MS });
		// Registration rarely changes while backgrounded. Avoid a server
		// round trip on every foreground; the permission listener covers changes.
		if (reason !== 'online' && Date.now() - lastPushRefresh.current < PUSH_REFRESH_INTERVAL_MS) return;
		lastPushRefresh.current = Date.now();
		void refreshPushState().catch(() => undefined);
	}), [enabled, authToken, bootstrapped, loadReminders, refreshPushState]);
}
