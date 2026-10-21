import { useEffect, useRef } from 'react';
import type { LoadReminders } from './types';

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

	useEffect(() => {
		const resume = (event?: Event) => {
			if (!enabled || !bootstrapped || !authToken) return;
			// Reconnection must recover changes missed offline, even after a recent read.
			void loadReminders({ silent: true, maxAgeMs: event?.type === 'online' ? 0 : 30_000 });
			// Registration rarely changes while backgrounded. Avoid a server
			// round trip on every foreground; the permission listener covers changes.
			if (event?.type !== 'online' && Date.now() - lastPushRefresh.current < PUSH_REFRESH_INTERVAL_MS) return;
			lastPushRefresh.current = Date.now();
			void refreshPushState().catch(() => undefined);
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') resume();
		};

		window.addEventListener('pageshow', resume);
		window.addEventListener('online', resume);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			window.removeEventListener('pageshow', resume);
			window.removeEventListener('online', resume);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [enabled, authToken, bootstrapped, loadReminders, refreshPushState]);
}
