import { useCallback, useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { fetchPwaAssetVersion } from '../api';
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
}): boolean {
	const [updateAvailable, setUpdateAvailable] = useState(false);

	useEffect(() => {
		if (!bootstrapped || !authToken) return;
		void Promise.all([
			loadReminders({ silent: hydratedCacheRef.current }),
			refreshPushState().catch(() => undefined),
		]);
	}, [authToken, bootstrapped, hydratedCacheRef, loadReminders, refreshPushState]);

	const checkForUpdate = useCallback(async () => {
		try {
			const assetVersion = await fetchPwaAssetVersion();
			if (assetVersion && assetVersion !== PWA_ASSET_VERSION) {
				setUpdateAvailable(true);
			}
		} catch {
			// Version checks are opportunistic and should not disrupt reminder use.
		}
	}, []);

	useEffect(() => {
		void checkForUpdate();
	}, [checkForUpdate]);

	useEffect(() => {
		const resume = () => {
			void checkForUpdate();
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
	}, [authToken, bootstrapped, checkForUpdate, loadReminders, refreshPushState]);

	return updateAvailable;
}
