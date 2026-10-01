import { normalizeDockTabs, type DockTab } from './dock-preferences';
import type { StartTab } from './types';
import { DEFAULT_REMINDER_LIST_STYLE, normalizeReminderListStyle, type ReminderListStyle } from '../reminders/types/reminder-list-style';

type PwaStartScreen = StartTab | 'reading' | 'favorites' | 'archive';

export const PWA_PREFERENCES_KEY = 'crate-reminders-preferences';

export interface PwaPreferences {
	defaultScreen: PwaStartScreen;
	dockTabs: DockTab[];
	upcomingDays: number | null;
	reminderListStyle: ReminderListStyle;
}

export function loadPwaPreferences(): PwaPreferences {
	try {
		const value = JSON.parse(localStorage.getItem(PWA_PREFERENCES_KEY) ?? '{}') as Partial<PwaPreferences> | null;
		return {
			reminderListStyle: normalizeReminderListStyle(value?.reminderListStyle),
			dockTabs: normalizeDockTabs(value?.dockTabs),
			defaultScreen: value?.defaultScreen === 'inbox' || value?.defaultScreen === 'upcoming' || value?.defaultScreen === 'browse'
				|| value?.defaultScreen === 'reading' || value?.defaultScreen === 'favorites' || value?.defaultScreen === 'archive'
				? value.defaultScreen : 'today',
			upcomingDays: typeof value?.upcomingDays === 'number' && Number.isSafeInteger(value.upcomingDays) && value.upcomingDays >= 1
				? value.upcomingDays : null,
		};
	} catch {
		return { defaultScreen: 'today', upcomingDays: null, dockTabs: normalizeDockTabs(null), reminderListStyle: DEFAULT_REMINDER_LIST_STYLE };
	}
}

export function savePwaPreferences(preferences: PwaPreferences): void {
	localStorage.setItem(PWA_PREFERENCES_KEY, JSON.stringify(preferences));
}
