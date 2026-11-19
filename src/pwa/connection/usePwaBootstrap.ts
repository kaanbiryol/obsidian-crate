import { connectionIssue, SESSION_RECOVERY_ISSUE, type ConnectionIssue } from './issues';
import { capturePwaSession } from './session-generation';
import { EncryptionKeyRequiredError } from '../encryption/encryption-onboarding';
import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { AUTH_TOKEN_KEY, applyConfigFromUrl, loadStoredConfig, saveConfig } from '../config';
import { finishEnrollment } from './enrollment';
import { redeemLaunchEnrollment } from './launch-enrollment';
import { makeApiFetch } from './api-fetch';
import { reminderTransport } from '../reminders/reminder-transport';
import type { ShowToast, StartTab, StoredConfig } from '../types';

export function usePwaBootstrap({
	authToken,
	suspendLocalSession,
	setAuthToken,
	setBootstrapped,
	setEnrolled,
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
	setEnrolled: Dispatch<SetStateAction<boolean>>;
	setConfig: Dispatch<SetStateAction<StoredConfig>>;
	reportError: (issue: ConnectionIssue | null) => void;
	setLaunchReminderId: Dispatch<SetStateAction<string | null>>;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
	setStartTab: Dispatch<SetStateAction<StartTab>>;
	showToast: ShowToast;
}): void {
	// Bootstrap owns a single mount-time session, even if callers rerender during enrollment.
	const initialOptionsRef = useRef({
		authToken, suspendLocalSession,
		setAuthToken, setBootstrapped, setEnrolled, setConfig, reportError, setLaunchReminderId,
		setSelectedProject, setStartTab, showToast,
	});

	useEffect(() => {
		const {
			authToken: initialAuthToken, suspendLocalSession,
			setAuthToken, setBootstrapped, setEnrolled, setConfig, reportError, setLaunchReminderId,
			setSelectedProject, setStartTab, showToast,
		} = initialOptionsRef.current;
		let cancelled = false;
		// Redemption replaces the session; `redeemLaunchEnrollment` updates this fence in place.
		const session = { current: capturePwaSession() };

		async function bootstrap() {
			try {
				if (cancelled || !session.current()) return;
				const storedConfig = loadStoredConfig();
				const applied = applyConfigFromUrl(storedConfig);
				const enrollment = await redeemLaunchEnrollment({
					applied, storedConfig, authToken: initialAuthToken, session, cancelled: () => cancelled,
					suspendLocalSession, showToast,
				});
				if (!enrollment) return;
				const { token: nextToken, config: nextConfig, enrollmentFailed } = enrollment;
				if (enrollment.redeemed) setAuthToken(nextToken);
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
				// Reading needs only the enrolled credential, so its encryption
				// check can run alongside the Reminders one below.
				setEnrolled(true);

				if (!nextToken) return;
				await makeApiFetch(nextToken, () => { void suspendLocalSession(); reportError(SESSION_RECOVERY_ISSUE); }, reminderTransport).ready();
				if (cancelled || !session.current()) return;

			} catch (bootstrapError) {
				if (!cancelled && session.current()) {
					if (localStorage.getItem(AUTH_TOKEN_KEY)) {
						if (bootstrapError instanceof EncryptionKeyRequiredError && bootstrapError.firstUnlock) return;
						showToast('error', bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
						return;
					}
					const clearing = suspendLocalSession();
					session.current = capturePwaSession();
					await clearing;
					if (cancelled || !session.current()) return;
					reportError(connectionIssue(bootstrapError));
				}
			} finally {
				// Storage events adopt a replacement or logout from another tab.
				// Finishing bootstrap lets that session load instead of hanging.
				if (!cancelled) {
					setEnrolled(true);
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
