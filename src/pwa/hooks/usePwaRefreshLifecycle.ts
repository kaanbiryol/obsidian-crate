import { useEffect } from 'react';
import type { LoadReminders } from '../types';

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

	useEffect(() => {
		if (!enabled || !bootstrapped || !authToken) return;
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
