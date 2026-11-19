import { capturePwaSession } from './session-generation';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, PWA_LOGOUT_KEY, saveConfig, type applyConfigFromUrl } from '../config';
import { isStandaloneApp } from '../shell/device';
import { enrollmentFingerprint, rememberRedeemedEnrollment, wasEnrollmentRedeemed } from './install-enrollment';
import { exchangeEnrollmentToken } from './enrollment-exchange';
import type { ShowToast, StoredConfig } from '../types';

/** The session this launch runs on after its link's one-time grant, if any, is handled. */
export interface LaunchEnrollment {
	token: string | null;
	config: StoredConfig;
	/** A replacement link failed while an existing session stayed signed in. */
	enrollmentFailed: boolean;
	/** This launch redeemed its link and stored `token` as the session credential. */
	redeemed: boolean;
}

/**
 * Redeems the enrollment link a launch carries. Returns null when a cancel, logout or
 * another tab's session replaced this launch, which then stops.
 *
 * `session.current` is the bootstrap's session fence. Redemption replaces the session, so
 * this updates the fence in place: the caller's later checks, including in its error
 * handling, must see the replacement.
 */
export async function redeemLaunchEnrollment({ applied, storedConfig, authToken, session, cancelled, suspendLocalSession, showToast }: {
	applied: ReturnType<typeof applyConfigFromUrl>;
	storedConfig: StoredConfig;
	authToken: string | null;
	session: { current: () => boolean };
	cancelled: () => boolean;
	suspendLocalSession: () => Promise<void>;
	showToast: ShowToast;
}): Promise<LaunchEnrollment | null> {
	const stale = () => cancelled() || !session.current();
	let token = authToken;
	// Existing credentials are folder-scoped. A cleaned-up old link
	// must not change their configuration without a new enrollment.
	let config = token && !applied.token ? storedConfig : applied.config;
	const fingerprint = applied.token ? await enrollmentFingerprint(applied.token) : null;
	if (stale()) return null;
	if (!applied.token || !fingerprint) return { token, config, enrollmentFailed: false, redeemed: false };
	if (wasEnrollmentRedeemed(fingerprint)) {
		// Old icons also carry old folder settings. Keep the renewed
		// session's configuration when ignoring their spent grant.
		return { token, config: storedConfig, enrollmentFailed: false, redeemed: false };
	}
	try {
		const previousLogout = localStorage.getItem(PWA_LOGOUT_KEY);
		token = await exchangeEnrollmentToken(applied.token, token);
		// Revoking the replaced credential can cause an older tab's
		// in-flight read to suspend it before this response arrives.
		// Adopt this explicit enrollment only if no user logout or
		// another authenticated replacement intervened.
		if (!cancelled() && !session.current() && !localStorage.getItem(AUTH_TOKEN_KEY)
			&& previousLogout === localStorage.getItem(PWA_LOGOUT_KEY)) session.current = capturePwaSession();
	} catch (error) {
		if (stale()) return null;
		if (!token) throw error;
		// A bad or temporarily unavailable replacement link says
		// nothing about the validity of the existing session.
		showToast('error', `Could not reconnect: ${error instanceof Error ? error.message : String(error)}`);
		return stale() ? null : { token, config: storedConfig, enrollmentFailed: true, redeemed: false };
	}
	if (stale()) return null;
	const clearing = suspendLocalSession();
	session.current = capturePwaSession();
	await clearing;
	if (stale()) return null;
	rememberRedeemedEnrollment(fingerprint, isStandaloneApp());
	// Other tabs read config on the auth storage event.
	saveConfig(config);
	localStorage.setItem(AUTH_TOKEN_KEY, token);
	window.dispatchEvent(new Event(PWA_AUTH_CHANGED_EVENT));
	session.current = capturePwaSession();
	return { token, config, enrollmentFailed: false, redeemed: true };
}
