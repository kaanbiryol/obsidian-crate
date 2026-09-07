import { pwaStartSearchFromUrl } from '../cloudflare/worker/pwa/pwa-params';

const INSTALL_COOKIE = 'crate-reminders-install';
const REDEEMED_KEY = 'crate-reminders-redeemed-enrollment';
const INSTALL_TTL_SECONDS = 10 * 60;

function writeInstallCookie(value: string, maxAge: number): void {
	try {
		document.cookie = `${INSTALL_COOKIE}=${encodeURIComponent(value)}; Path=/notifications; Max-Age=${maxAge}; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`;
	} catch {
		// The install URL still works when cookies are disabled.
	}
}

export function clearInstallEnrollment(): void {
	writeInstallCookie('', 0);
}

export function preserveInstallEnrollment(url: string): void {
	const search = pwaStartSearchFromUrl(url);
	if (!new URLSearchParams(search).get('token')) return;
	// iOS copies cookies into a new Home Screen app, but not local/session
	// storage. Carry only the short-lived, single-use install grant, never
	// Safari's browser grant or its persistent authentication credential.
	writeInstallCookie(search, INSTALL_TTL_SECONDS);
}

export function restoreInstallEnrollment(params: URLSearchParams): URLSearchParams {
	if (params.get('token')?.trim()) return params;
	try {
		const cookie = document.cookie.split(';').map(value => value.trim())
			.find(value => value.startsWith(`${INSTALL_COOKIE}=`));
		if (!cookie) return params;
		const restored = new URLSearchParams(decodeURIComponent(cookie.slice(INSTALL_COOKIE.length + 1)));
		// Keep an explicit launch target (for example, a notification's reminder).
		params.forEach((value, key) => {
			if (key !== 'token') restored.set(key, value);
		});
		return restored;
	} catch {
		return params;
	}
}

export async function enrollmentFingerprint(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function wasEnrollmentRedeemed(fingerprint: string): boolean {
	return localStorage.getItem(REDEEMED_KEY) === fingerprint;
}

export function rememberRedeemedEnrollment(fingerprint: string): void {
	// The installed start URL may be opened on every cold launch. Remember a
	// fingerprint so a spent grant cannot replace (or clear) a working session.
	localStorage.setItem(REDEEMED_KEY, fingerprint);
}
