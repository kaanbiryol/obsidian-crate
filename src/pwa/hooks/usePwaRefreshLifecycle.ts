import { useCallback, useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { fetchPwaAssetVersion, replaceBrowserUrlWithInstallToken } from '../api';
import { isStandaloneApp } from '../config';
import type { ApiFetch, LoadReminders, StoredConfig } from '../types';

export function usePwaRefreshLifecycle({
	apiFetch,
	authToken,
	bootstrapped,
	config,
	hydratedCacheRef,
	loadReminders,
	refreshPushState,
}: {
	apiFetch: ApiFetch;
	authToken: string | null;
	bootstrapped: boolean;
	config: StoredConfig;
	hydratedCacheRef: MutableRefObject<boolean>;
	loadReminders: LoadReminders;
	refreshPushState: () => Promise<void>;
}): boolean {
	const [updateAvailable, setUpdateAvailable] = useState(false);

	const refreshInstallActivationUrl = useCallback(async () => {
		if (!authToken || isStandaloneApp()) return;
		const response = await apiFetch('/notifications/reminders-enrollment-token', { method: 'POST' });
		if (!response.ok) throw new Error(await response.text());
		const result = await response.json() as { token?: string; browserToken?: string };
		if (!result.token) throw new Error('Missing install token');
		replaceBrowserUrlWithInstallToken(result.token, config, result.browserToken);
	}, [apiFetch, authToken, config]);

	useEffect(() => {
		if (!bootstrapped || !authToken) return;
		void refreshInstallActivationUrl().catch(() => undefined);
		void Promise.all([
			loadReminders({ silent: hydratedCacheRef.current }),
			refreshPushState().catch(() => undefined),
		]);
	}, [authToken, bootstrapped, hydratedCacheRef, loadReminders, refreshInstallActivationUrl, refreshPushState]);

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
		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			window.removeEventListener('pageshow', resume);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [authToken, bootstrapped, checkForUpdate, loadReminders, refreshPushState]);

	return updateAvailable;
}
