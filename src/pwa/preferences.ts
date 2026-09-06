import type { StartTab } from './types';

const PREFERENCES_KEY = 'crate-reminders-preferences';

export interface PwaPreferences {
	defaultScreen: StartTab;
	upcomingDays: number | null;
}

export function loadPwaPreferences(): PwaPreferences {
	try {
		const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Partial<PwaPreferences> | null;
		return {
			defaultScreen: value?.defaultScreen === 'inbox' || value?.defaultScreen === 'upcoming' || value?.defaultScreen === 'browse'
				? value.defaultScreen : 'today',
			upcomingDays: typeof value?.upcomingDays === 'number' && Number.isSafeInteger(value.upcomingDays) && value.upcomingDays >= 1
				? value.upcomingDays : null,
		};
	} catch {
		return { defaultScreen: 'today', upcomingDays: null };
	}
}

export function savePwaPreferences(preferences: PwaPreferences): void {
	localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}
