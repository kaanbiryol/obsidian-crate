import type { CachedReminderSnapshot, ReminderRecord, StartTab, StoredConfig } from './types';

export const AUTH_TOKEN_KEY = 'crate-reminders-auth-token';
const CONFIG_KEY = 'crate-reminders-config';
export const REMINDERS_CACHE_KEY = 'crate-reminders-cache-v1';
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

function saveConfig(config: StoredConfig): void {
	localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function loadCachedReminderSnapshot(folderPath: string): CachedReminderSnapshot | null {
	try {
		const raw = localStorage.getItem(REMINDERS_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<CachedReminderSnapshot>;
		if (parsed.folderPath !== folderPath) return null;
		if (!Array.isArray(parsed.reminders) || !Array.isArray(parsed.projects) || typeof parsed.savedAt !== 'number') {
			return null;
		}
		return {
			folderPath,
			reminders: parsed.reminders,
			projects: parsed.projects.filter((project): project is string => typeof project === 'string'),
			savedAt: parsed.savedAt,
		};
	} catch {
		return null;
	}
}

export function saveCachedReminderSnapshot(folderPath: string, reminders: ReminderRecord[], projects: string[], savedAt = Date.now()): void {
	try {
		const snapshot: CachedReminderSnapshot = { folderPath, reminders, projects, savedAt };
		localStorage.setItem(REMINDERS_CACHE_KEY, JSON.stringify(snapshot));
	} catch {
		// Best-effort cache for offline display; storage can be unavailable in private contexts.
	}
}

export function currentQueryParams(): URLSearchParams {
	return new URLSearchParams(window.location.search);
}

export function detectDeviceName(): string {
	const ua = navigator.userAgent;
	if (/iPhone/i.test(ua)) return 'iPhone';
	if (/iPad/i.test(ua)) return 'iPad';
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

export function applyConfigFromUrl(config: StoredConfig): {
	config: StoredConfig;
	token: string | null;
	project: string | null;
	tab: StartTab | null;
	reminderId: string | null;
} {
	const params = currentQueryParams();
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

	saveConfig(nextConfig);
	return {
		config: nextConfig,
		token: params.get('token'),
		project: params.get('project'),
		tab: parseStartTab(params.get('tab')),
		reminderId: reminderId || null,
	};
}
