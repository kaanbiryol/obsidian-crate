import { create } from 'zustand';
import { isRecord } from '../plugin/settings';
import type { TabId } from './ui/layoutConstants';

export type DueDateDefaultSetting = 'none' | 'today' | 'tomorrow';

export type AutoOpenSetting = 'none' | 'sidebar' | 'fullscreen';

export const DEFAULT_REMINDERS_FOLDER_PATH = 'Reminders';

const VALID_DUE_DATE_DEFAULTS = new Set<string>(['none', 'today', 'tomorrow']);
const VALID_AUTO_OPEN_SETTINGS = new Set<string>(['none', 'sidebar', 'fullscreen']);
const VALID_TAB_IDS = new Set<string>(['inbox', 'today', 'upcoming', 'browse']);

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

function isTabId(value: unknown): value is TabId {
	return typeof value === 'string' && VALID_TAB_IDS.has(value);
}

function isDueDateDefaultSetting(value: unknown): value is DueDateDefaultSetting {
	return typeof value === 'string' && VALID_DUE_DATE_DEFAULTS.has(value);
}

function isAutoOpenSetting(value: unknown): value is AutoOpenSetting {
	return typeof value === 'string' && VALID_AUTO_OPEN_SETTINGS.has(value);
}

function normalizeTabId(value: unknown, fallback: TabId): TabId {
	return isTabId(value)
		? value
		: fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

function containsControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

export function normalizeRemindersFolderPath(rawPath: string | null | undefined): string {
	const trimmed = rawPath?.trim();
	if (!trimmed) {
		return DEFAULT_REMINDERS_FOLDER_PATH;
	}

	const normalized = trimmed
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!normalized) {
		return DEFAULT_REMINDERS_FOLDER_PATH;
	}

	const segments = normalized.split('/');
	const safeSegments: string[] = [];
	for (const segment of segments) {
		const safeSegment = segment.trim();
		if (
			!safeSegment
			|| safeSegment === '.'
			|| safeSegment === '..'
			|| containsControlCharacters(safeSegment)
		) {
			return DEFAULT_REMINDERS_FOLDER_PATH;
		}
		safeSegments.push(safeSegment);
	}

	return safeSegments.join('/');
}

export function normalizeRemindersSettings(
	value: Partial<RemindersSettings> | null | undefined,
): RemindersSettings {
	return {
		debugLogging: typeof value?.debugLogging === 'boolean'
			? value.debugLogging
			: DEFAULT_REMINDERS_SETTINGS.debugLogging,
		taskCreationDefaultDueDate: isDueDateDefaultSetting(value?.taskCreationDefaultDueDate)
			? value.taskCreationDefaultDueDate
			: DEFAULT_REMINDERS_SETTINGS.taskCreationDefaultDueDate,
		remindersFolderPath: normalizeRemindersFolderPath(value?.remindersFolderPath),
		queryViewPreferences: normalizeQueryViewPreferences(value?.queryViewPreferences),
		upcomingDaysDefault: normalizePositiveInteger(
			value?.upcomingDaysDefault,
			DEFAULT_REMINDERS_SETTINGS.upcomingDaysDefault,
		),
		autoOpenView: isAutoOpenSetting(value?.autoOpenView)
			? value.autoOpenView
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
