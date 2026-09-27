import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { LoadReminders } from '../types';

export function usePwaRefreshLifecycle({
	authToken,
	bootstrapped,
	hydratedCacheRef,
	loadReminders,
	refreshPushState,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	hydratedCacheRef: MutableRefObject<boolean>;
	loadReminders: LoadReminders;
	refreshPushState: () => Promise<void>;
}) {

	useEffect(() => {
		if (!bootstrapped || !authToken) return;
		void Promise.all([
			loadReminders({ silent: hydratedCacheRef.current }),
			refreshPushState().catch(() => undefined),
		]);
	}, [authToken, bootstrapped, hydratedCacheRef, loadReminders, refreshPushState]);

	useEffect(() => {
		const resume = () => {
			if (!bootstrapped || !authToken) return;
			void loadReminders({ silent: true, maxAgeMs: 30_000 });
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
	}, [authToken, bootstrapped, loadReminders, refreshPushState]);
}
