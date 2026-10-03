import { preserveIncomingShare } from '../connection/incoming-share';
import { SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { capturePwaSession } from '../session-generation';
import { EncryptionKeyRequiredError } from '../encryption-onboarding';
import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
	AUTH_TOKEN_KEY,
	PWA_AUTH_CHANGED_EVENT,
	PWA_LOGOUT_KEY,
	applyConfigFromUrl,
	finishEnrollment,
	isStandaloneApp,
	loadStoredConfig,
	saveConfig,
} from '../config';
import { enrollmentFingerprint, rememberRedeemedEnrollment, wasEnrollmentRedeemed } from '../install-enrollment';
import { exchangeEnrollmentToken, makeApiFetch } from '../api';
import { scopeLegacyReminderDrafts } from '../reminder-drafts';
import type { ShowToast, StartTab, StoredConfig } from '../types';

export function usePwaBootstrap({
	authToken,
	suspendLocalSession,
	setAuthToken,
	setBootstrapped,
	setConfig,
	reportError,
	setLaunchReminderId,
	setSelectedProject,
	setStartTab,
	showToast,
}: {
	authToken: string | null;
	suspendLocalSession: () => Promise<void>;
	setAuthToken: Dispatch<SetStateAction<string | null>>;
	setBootstrapped: Dispatch<SetStateAction<boolean>>;
	setConfig: Dispatch<SetStateAction<StoredConfig>>;
	reportError: (message: string | null) => void;
	setLaunchReminderId: Dispatch<SetStateAction<string | null>>;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
	setStartTab: Dispatch<SetStateAction<StartTab>>;
	showToast: ShowToast;
}): void {
	// Bootstrap owns a single mount-time session, even if callers rerender during enrollment.
	const initialOptionsRef = useRef({
		authToken, suspendLocalSession,
		setAuthToken, setBootstrapped, setConfig, reportError, setLaunchReminderId,
		setSelectedProject, setStartTab, showToast,
	});

	useEffect(() => {
		const {
			authToken: initialAuthToken, suspendLocalSession,
			setAuthToken, setBootstrapped, setConfig, reportError, setLaunchReminderId,
			setSelectedProject, setStartTab, showToast,
		} = initialOptionsRef.current;
		let cancelled = false;
		let sessionCurrent = capturePwaSession();

		async function bootstrap() {
			try {
				if (cancelled || !sessionCurrent()) return;
				await preserveIncomingShare(() => !cancelled && sessionCurrent());
				if (cancelled || !sessionCurrent()) return;
				const storedConfig = loadStoredConfig();
				scopeLegacyReminderDrafts(storedConfig.folderPath);
				const applied = applyConfigFromUrl(storedConfig);
				let nextToken = initialAuthToken;
				// Existing credentials are folder-scoped. A cleaned-up old link
				// must not change their configuration without a new enrollment.
				let nextConfig = nextToken && !applied.token ? storedConfig : applied.config;
				const fingerprint = applied.token ? await enrollmentFingerprint(applied.token) : null;
				if (cancelled || !sessionCurrent()) return;
				let enrollmentFailed = false;
				if (applied.token && fingerprint) {
					if (wasEnrollmentRedeemed(fingerprint)) {
						// Old icons also carry old folder settings. Keep the renewed
						// session's configuration when ignoring their spent grant.
						nextConfig = storedConfig;
					} else {
						try {
							const previousLogout = localStorage.getItem(PWA_LOGOUT_KEY);
							nextToken = await exchangeEnrollmentToken(applied.token, nextToken);
							// Revoking the replaced credential can cause an older tab's
							// in-flight read to suspend it before this response arrives.
							// Adopt this explicit enrollment only if no user logout or
							// another authenticated replacement intervened.
							if (!cancelled && !sessionCurrent() && !localStorage.getItem(AUTH_TOKEN_KEY)
								&& previousLogout === localStorage.getItem(PWA_LOGOUT_KEY)) sessionCurrent = capturePwaSession();
						} catch (error) {
							if (cancelled || !sessionCurrent()) return;
							if (!nextToken) throw error;
							// A bad or temporarily unavailable replacement link says
							// nothing about the validity of the existing session.
							enrollmentFailed = true;
							nextConfig = storedConfig;
							showToast('error', `Could not reconnect: ${error instanceof Error ? error.message : String(error)}`);
						}
						if (cancelled || !sessionCurrent()) return;
						if (!enrollmentFailed) {
							const clearing = suspendLocalSession();
							sessionCurrent = capturePwaSession();
							await clearing;
							if (cancelled || !sessionCurrent()) return;
							rememberRedeemedEnrollment(fingerprint, isStandaloneApp());
							// Other tabs read config on the auth storage event.
							saveConfig(nextConfig);
							localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
							window.dispatchEvent(new Event(PWA_AUTH_CHANGED_EVENT));
							sessionCurrent = capturePwaSession();
							setAuthToken(nextToken);
						}
					}
				}
				saveConfig(nextConfig);
				setConfig(nextConfig);
				const matchingLaunch = !enrollmentFailed && nextConfig.folderPath === applied.config.folderPath;
				if (matchingLaunch && applied.project) {
					setSelectedProject(applied.project);
				}
				if (applied.tab) {
					setStartTab(applied.tab);
				}
				if (matchingLaunch && applied.reminderId) {
					setLaunchReminderId(applied.reminderId);
				}
				if (!enrollmentFailed) finishEnrollment();

				if (!nextToken) return;
				await makeApiFetch(nextToken, () => { void suspendLocalSession(); reportError(SESSION_RECOVERY_MESSAGE); }).ready();
				if (cancelled || !sessionCurrent()) return;

			} catch (bootstrapError) {
				if (!cancelled && sessionCurrent()) {
					if (localStorage.getItem(AUTH_TOKEN_KEY)) {
						if (bootstrapError instanceof EncryptionKeyRequiredError && bootstrapError.firstUnlock) return;
						showToast('error', bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
						return;
					}
					const clearing = suspendLocalSession();
					sessionCurrent = capturePwaSession();
					await clearing;
					if (cancelled || !sessionCurrent()) return;
					reportError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
				}
			} finally {
				// Storage events adopt a replacement or logout from another tab.
				// Finishing bootstrap lets that session load instead of hanging.
				if (!cancelled) {
					setBootstrapped(true);
				}
			}
		}

		// Serialize one-time exchanges across tabs. Session fences still protect
		// browsers without Web Locks and logout during a pending exchange.
		if (navigator.locks) void navigator.locks.request('crate-reminders-enrollment', bootstrap);
		else void bootstrap();
		return () => {
			cancelled = true;
		};
	}, []);
}
