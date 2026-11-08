import type { StartTab, StoredConfig } from './types';
import { manifestHrefForUrl } from './shell/pwa-params';
import { preserveInstallEnrollment, restoreInstallEnrollment } from './connection/install-enrollment';
import { enrollmentTokenFromParams } from './connection/enrollment';
import { isStandaloneApp } from './shell/device';
import { normalizeTimeString } from '../platform/validation';

export const AUTH_TOKEN_KEY = 'crate-reminders-auth-token';
export const PWA_AUTH_CHANGED_EVENT = 'crate-reminders-auth-change';
export const PWA_LOGOUT_KEY = 'crate-reminders-logout';
export const PWA_FOLDER_CHANGED_EVENT = 'crate-reminders-folder-change';
const CONFIG_KEY = 'crate-reminders-config';

const defaultConfig: StoredConfig = {
	folderPath: 'Reminders',
	upcomingDays: 7,
	allDayNotificationTime: null,
};

export function parseStartTab(value: unknown): StartTab | null {
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

/** The server moved this session to the vault's current reminders folder. Each tab
 * adopts it from its own request, so a replaced session's tab never follows. */
export function adoptReminderFolder(folderPath: string): void {
	const config = loadStoredConfig();
	if (config.folderPath === folderPath) return;
	saveConfig({ ...config, folderPath });
	window.dispatchEvent(new Event(PWA_FOLDER_CHANGED_EVENT));
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
	const launchParams = new URLSearchParams(window.location.search);
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
	// Encrypted vaults send the folder's plaintext name only in the fragment.
	const folderPath = params.get('folder') ?? new URLSearchParams(window.location.hash.slice(1)).get('crateFolder');
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
