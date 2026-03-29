import { create } from 'zustand';
import type { TabId } from './ui/layoutConstants';

export type DueDateDefaultSetting = 'none' | 'today' | 'tomorrow';

export type AutoOpenSetting = 'none' | 'sidebar' | 'fullscreen';

export const DEFAULT_REMINDERS_FOLDER_PATH = 'Reminders';

const VALID_DUE_DATE_DEFAULTS = new Set<DueDateDefaultSetting>(['none', 'today', 'tomorrow']);
const VALID_AUTO_OPEN_SETTINGS = new Set<AutoOpenSetting>(['none', 'sidebar', 'fullscreen']);
const VALID_TAB_IDS = new Set<TabId>(['inbox', 'today', 'upcoming', 'browse']);

type QueryViewPreference = {
	showCompleted?: boolean;
};

export type RemindersSettings = {
	debugLogging: boolean;
	taskCreationDefaultDueDate: DueDateDefaultSetting;
	remindersFolderPath: string;
	queryViewPreferences: Record<string, QueryViewPreference>;
	upcomingDaysDefault: number;
	autoOpenView: AutoOpenSetting;
	sidebarDefaultTab: TabId;
	fullscreenDefaultTab: TabId;
};

export const DEFAULT_REMINDERS_SETTINGS: RemindersSettings = {
	debugLogging: true,
	taskCreationDefaultDueDate: 'none',
	remindersFolderPath: DEFAULT_REMINDERS_FOLDER_PATH,
	queryViewPreferences: {},
	upcomingDaysDefault: 7,
	autoOpenView: 'none',
	sidebarDefaultTab: 'inbox',
	fullscreenDefaultTab: 'inbox',
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeQueryViewPreferences(
	value: unknown,
): Record<string, QueryViewPreference> {
	if (!isRecord(value)) {
		return {};
	}

	const normalized: Record<string, QueryViewPreference> = {};
	for (const [key, preference] of Object.entries(value)) {
		if (!key.trim() || !isRecord(preference)) {
			continue;
		}

		if (typeof preference.showCompleted === 'boolean') {
			normalized[key] = { showCompleted: preference.showCompleted };
		}
	}

	return normalized;
}

function normalizeTabId(value: unknown, fallback: TabId): TabId {
	return typeof value === 'string' && VALID_TAB_IDS.has(value as TabId)
		? value as TabId
		: fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

export function normalizeRemindersFolderPath(rawPath: string | null | undefined): string {
	const trimmed = rawPath?.trim().replace(/^\/+|\/+$/g, '');
	return trimmed || DEFAULT_REMINDERS_FOLDER_PATH;
}

export function normalizeRemindersSettings(
	value: Partial<RemindersSettings> | null | undefined,
): RemindersSettings {
	return {
		debugLogging: typeof value?.debugLogging === 'boolean'
			? value.debugLogging
			: DEFAULT_REMINDERS_SETTINGS.debugLogging,
		taskCreationDefaultDueDate:
			typeof value?.taskCreationDefaultDueDate === 'string'
			&& VALID_DUE_DATE_DEFAULTS.has(value.taskCreationDefaultDueDate as DueDateDefaultSetting)
				? value.taskCreationDefaultDueDate as DueDateDefaultSetting
				: DEFAULT_REMINDERS_SETTINGS.taskCreationDefaultDueDate,
		remindersFolderPath: normalizeRemindersFolderPath(value?.remindersFolderPath),
		queryViewPreferences: normalizeQueryViewPreferences(value?.queryViewPreferences),
		upcomingDaysDefault: normalizePositiveInteger(
			value?.upcomingDaysDefault,
			DEFAULT_REMINDERS_SETTINGS.upcomingDaysDefault,
		),
		autoOpenView:
			typeof value?.autoOpenView === 'string'
			&& VALID_AUTO_OPEN_SETTINGS.has(value.autoOpenView as AutoOpenSetting)
				? value.autoOpenView as AutoOpenSetting
				: DEFAULT_REMINDERS_SETTINGS.autoOpenView,
		sidebarDefaultTab: normalizeTabId(
			value?.sidebarDefaultTab,
			DEFAULT_REMINDERS_SETTINGS.sidebarDefaultTab,
		),
		fullscreenDefaultTab: normalizeTabId(
			value?.fullscreenDefaultTab,
			DEFAULT_REMINDERS_SETTINGS.fullscreenDefaultTab,
		),
	};
}

export const useRemindersSettingsStore = create<RemindersSettings>(() => ({
	...DEFAULT_REMINDERS_SETTINGS,
}));
