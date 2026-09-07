import type { StartTab, StoredConfig } from './types';
import { manifestHrefForUrl } from '../cloudflare/worker/pwa/pwa-params';
import { clearInstallEnrollment, preserveInstallEnrollment, restoreInstallEnrollment } from './install-enrollment';

export const AUTH_TOKEN_KEY = 'crate-reminders-auth-token';
const CONFIG_KEY = 'crate-reminders-config';
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const defaultConfig: StoredConfig = {
	folderPath: 'Reminders',
	upcomingDays: 7,
	allDayNotificationTime: null,
};

function normalizeTimeString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = TIME_PATTERN.exec(value.trim());
	return match ? `${match[1]}:${match[2]}` : null;
}

function parseStartTab(value: unknown): StartTab | null {
	return value === 'inbox' || value === 'today' || value === 'upcoming' || value === 'browse'
		? value
		: null;
}

export function loadStoredConfig(): StoredConfig {
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		if (!raw) return { ...defaultConfig };
		const parsed = JSON.parse(raw) as Partial<StoredConfig>;
		return {
			folderPath: typeof parsed.folderPath === 'string' && parsed.folderPath.trim()
				? parsed.folderPath.trim()
				: defaultConfig.folderPath,
			upcomingDays: typeof parsed.upcomingDays === 'number' && Number.isInteger(parsed.upcomingDays) && parsed.upcomingDays > 0
				? parsed.upcomingDays
				: defaultConfig.upcomingDays,
			allDayNotificationTime: normalizeTimeString(parsed.allDayNotificationTime),
		};
	} catch {
		return { ...defaultConfig };
	}
}

export function saveConfig(config: StoredConfig): void {
	localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function currentQueryParams(): URLSearchParams {
	return new URLSearchParams(window.location.search);
}

export function urlWithoutEnrollmentTokens({
	pathname,
	search,
	hash,
}: Pick<Location, 'pathname' | 'search' | 'hash'>, preserveInstallToken = false): string {
	const params = new URLSearchParams(search);
	if (!preserveInstallToken) params.delete('token');
	params.delete('browserToken');
	const nextSearch = params.toString();
	return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
}

export function finishEnrollment(preserveInstallToken = !isStandaloneApp()): void {
	if (!preserveInstallToken) clearInstallEnrollment();
	const params = currentQueryParams();
	if (!params.has('token') && !params.has('browserToken')) return;
	// Keep Safari's install grant in the document URL as well as the manifest:
	// Add to Home Screen may use the document URL, and reloads must retain it.
	const nextUrl = urlWithoutEnrollmentTokens(window.location, preserveInstallToken);
	const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	if (nextUrl !== currentUrl) {
		window.history.replaceState(window.history.state, '', nextUrl);
	}
	const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
	if (manifest) manifest.href = manifestHrefForUrl(window.location.href);
}

type DeviceNavigator = Pick<Navigator, 'maxTouchPoints' | 'userAgent'>;

export function isIosOrIpados(deviceNavigator: DeviceNavigator = navigator): boolean {
	return /iPad|iPhone|iPod/i.test(deviceNavigator.userAgent)
		|| (/Macintosh/i.test(deviceNavigator.userAgent) && deviceNavigator.maxTouchPoints > 1);
}

export function detectDeviceName(deviceNavigator: DeviceNavigator = navigator): string {
	const ua = deviceNavigator.userAgent;
	if (/iPhone/i.test(ua)) return 'iPhone';
	if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && deviceNavigator.maxTouchPoints > 1)) return 'iPad';
	if (/Android/i.test(ua)) return 'Android';
	if (/Mac/i.test(ua)) return 'Mac';
	if (/Windows/i.test(ua)) return 'Windows';
	return 'Web';
}

export function isStandaloneApp(): boolean {
	return window.matchMedia('(display-mode: standalone)').matches
		|| Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function formatLastUpdated(timestamp: number | null, now: number): string {
	if (!timestamp) return 'Not updated yet';
	const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (elapsedSeconds < 45) return 'Last updated just now';
	if (elapsedSeconds < 90) return 'Last updated 1m ago';
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `Last updated ${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `Last updated ${elapsedHours}h ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	return `Last updated ${elapsedDays}d ago`;
}

export function enrollmentTokenFromParams(
	params: URLSearchParams,
	standalone = isStandaloneApp(),
): string | null {
	const installToken = params.get('token')?.trim() || null;
	const browserToken = params.get('browserToken')?.trim() || null;
	return standalone
		? installToken
		: browserToken;
}

/** Propose launch settings; bootstrap commits them after enrollment succeeds. */
export function applyConfigFromUrl(config: StoredConfig): {
	config: StoredConfig;
	token: string | null;
	project: string | null;
	tab: StartTab | null;
	reminderId: string | null;
} {
	const standalone = isStandaloneApp();
	const launchParams = currentQueryParams();
	const params = standalone && !localStorage.getItem(AUTH_TOKEN_KEY)
		? restoreInstallEnrollment(launchParams)
		: launchParams;
	const token = enrollmentTokenFromParams(params);
	// A service-worker cache hit supplies a generic shell, so its manifest
	// cannot carry this QR link's install token. Restore it before installation;
	// Safari's session storage is not the Home Screen app's enrollment channel.
	if (!standalone) {
		preserveInstallEnrollment(window.location.href);
		const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
		if (manifest) manifest.href = manifestHrefForUrl(window.location.href);
	}
	const nextConfig = { ...config };
	const folderPath = params.get('folder');
	const upcomingDays = params.get('upcomingDays');
	const allDayTime = params.get('allDayTime');
	const reminderId = params.get('reminderId')?.trim() ?? '';

	if (folderPath) nextConfig.folderPath = folderPath;
	if (upcomingDays) {
		const parsedDays = Number.parseInt(upcomingDays, 10);
		if (Number.isInteger(parsedDays) && parsedDays > 0) {
			nextConfig.upcomingDays = parsedDays;
		}
	}
	if (allDayTime) {
		nextConfig.allDayNotificationTime = normalizeTimeString(allDayTime);
	}

	return {
		config: nextConfig,
		token,
		project: params.get('project'),
		tab: parseStartTab(params.get('tab')),
		reminderId: reminderId || null,
	};
}
