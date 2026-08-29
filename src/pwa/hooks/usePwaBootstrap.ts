import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
	AUTH_TOKEN_KEY,
	applyConfigFromUrl,
	loadCachedReminderSnapshot,
	loadStoredConfig,
} from '../config';
import { exchangeEnrollmentToken, validateStoredAuthToken } from '../api';
import type { CachedReminderSnapshot, StartTab, StoredConfig } from '../types';

export function usePwaBootstrap({
	authToken,
	hydrateCachedSnapshot,
	hydratedCacheRef,
	setAuthToken,
	setBootstrapped,
	setConfig,
	setError,
	setLaunchReminderId,
	setLoading,
	setSelectedProject,
	setStartTab,
}: {
	authToken: string | null;
	hydrateCachedSnapshot: (snapshot: CachedReminderSnapshot) => void;
	hydratedCacheRef: MutableRefObject<boolean>;
	setAuthToken: Dispatch<SetStateAction<string | null>>;
	setBootstrapped: Dispatch<SetStateAction<boolean>>;
	setConfig: Dispatch<SetStateAction<StoredConfig>>;
	setError: Dispatch<SetStateAction<string | null>>;
	setLaunchReminderId: Dispatch<SetStateAction<string | null>>;
	setLoading: Dispatch<SetStateAction<boolean>>;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
	setStartTab: Dispatch<SetStateAction<StartTab>>;
}): void {
	const initialAuthTokenRef = useRef(authToken);

	useEffect(() => {
		let cancelled = false;

		async function bootstrap() {
			try {
				const applied = applyConfigFromUrl(loadStoredConfig());
				if (cancelled) return;
				setConfig(applied.config);
				if (applied.project) {
					setSelectedProject(applied.project);
				}
				if (applied.tab) {
					setStartTab(applied.tab);
				}
				if (applied.reminderId) {
					setLaunchReminderId(applied.reminderId);
				}

				let nextToken = initialAuthTokenRef.current;
				if (nextToken && applied.token) {
					const storedTokenValid = await validateStoredAuthToken(nextToken);
					if (cancelled) return;
					if (!storedTokenValid) {
						localStorage.removeItem(AUTH_TOKEN_KEY);
						nextToken = null;
					}
				}

				if (!nextToken && applied.token) {
					nextToken = await exchangeEnrollmentToken(applied.token);
					localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
					if (cancelled) return;
					setAuthToken(nextToken);
				}

				if (!nextToken) {
					setLoading(false);
					return;
				}

				const cached = loadCachedReminderSnapshot(applied.config.folderPath);
				hydratedCacheRef.current = Boolean(cached);
				if (cached) {
					hydrateCachedSnapshot(cached);
					setLoading(false);
				}
			} catch (bootstrapError) {
				if (!cancelled) {
					localStorage.removeItem(AUTH_TOKEN_KEY);
					setAuthToken(null);
					setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
					setLoading(false);
				}
			} finally {
				if (!cancelled) {
					setBootstrapped(true);
				}
			}
		}

		void bootstrap();
		return () => {
			cancelled = true;
		};
	}, []);
}
