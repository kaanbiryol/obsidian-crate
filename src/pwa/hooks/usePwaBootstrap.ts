import { capturePwaSession } from '../session-generation';
import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
	AUTH_TOKEN_KEY,
	applyConfigFromUrl,
	finishEnrollment,
	loadStoredConfig,
} from '../config';
import { enrollmentFingerprint, rememberRedeemedEnrollment, wasEnrollmentRedeemed } from '../install-enrollment';
import { exchangeEnrollmentToken } from '../api';
import { loadCachedReminderSnapshot } from '../reminder-cache';
import type { CachedReminderSnapshot, StartTab, StoredConfig } from '../types';

export function usePwaBootstrap({
	authToken,
	clearLocalSession,
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
	clearLocalSession: () => Promise<void>;
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
		let sessionCurrent = capturePwaSession();

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
				const fingerprint = applied.token ? await enrollmentFingerprint(applied.token) : null;
				if (cancelled || !sessionCurrent()) return;
				if (applied.token && fingerprint && !wasEnrollmentRedeemed(fingerprint)) {
					nextToken = await exchangeEnrollmentToken(applied.token, nextToken);
					if (cancelled || !sessionCurrent()) return;
					const clearing = clearLocalSession();
					sessionCurrent = capturePwaSession();
					await clearing;
					if (cancelled || !sessionCurrent()) return;
					localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
					rememberRedeemedEnrollment(fingerprint);
					sessionCurrent = capturePwaSession();
					setAuthToken(nextToken);
				}
				finishEnrollment();

				if (!nextToken) {
					setLoading(false);
					return;
				}

				const cached = await loadCachedReminderSnapshot(applied.config.folderPath);
				if (cancelled || !sessionCurrent()) return;
				hydratedCacheRef.current = Boolean(cached);
				if (cached) {
					hydrateCachedSnapshot(cached);
					setLoading(false);
				}
			} catch (bootstrapError) {
				if (!cancelled && sessionCurrent()) {
					const clearing = clearLocalSession();
					sessionCurrent = capturePwaSession();
					await clearing;
					if (cancelled || !sessionCurrent()) return;
					setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
					setLoading(false);
				}
			} finally {
				if (!cancelled && sessionCurrent()) {
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
