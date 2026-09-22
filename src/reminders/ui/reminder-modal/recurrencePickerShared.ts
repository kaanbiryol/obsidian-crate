import type { RecurrenceRule } from '../../types';
import { normalizeRecurrenceRule } from '../../utils/recurrenceRule';
import { getUiLocale } from '../../utils/uiLocale';

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceRule['frequency'], string> = {
	daily: 'Daily',
	weekly: 'Weekly',
	monthly: 'Monthly',
};

function recurrenceWeekdayDates(): Date[] {
	const sunday = new Date(2021, 7, 1);
	return Array.from({ length: 7 }, (_, day) => {
		const date = new Date(sunday);
		date.setDate(sunday.getDate() + day);
		return date;
	});
}

export function getRecurrenceDayLabels(locale = getUiLocale()): string[] {
	const formatter = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
	return recurrenceWeekdayDates().map((date) => formatter.format(date));
}

export function getRecurrenceDayNames(
	locale = getUiLocale(),
	width: 'long' | 'short' = 'long',
): string[] {
	const formatter = new Intl.DateTimeFormat(locale, { weekday: width });
	return recurrenceWeekdayDates().map((date) => formatter.format(date));
}

function formatRecurrenceTime(hour: number, minute: number, locale = getUiLocale()): string {
	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit', hourCycle: 'h23',
	}).format(new Date(2021, 7, 1, hour, minute));
}

export interface RecurrencePickerState {
	frequency: RecurrenceRule['frequency'];
	interval: number;
	daysOfWeek: number[];
	dayOfMonth: number;
	hour: number;
	minute: number;
	second?: number;
	millisecond?: number;
}

export interface RecurrencePickerDraft {
	frequency: RecurrenceRule['frequency'];
	interval: number;
	daysOfWeek: number[];
	dayOfMonth: number;
	time: string;
	second?: number;
	millisecond?: number;
}

export function getOrdinalSuffix(value: number): string {
	if (value === -1) return 'Last';
	const endings = ['th', 'st', 'nd', 'rd'];
	const mod = value % 100;
	return `${value}${endings[(mod - 20) % 10] || endings[mod] || endings[0]}`;
}

export function buildRecurrencePickerState(
	rule: RecurrenceRule | undefined,
	defaultDayOfMonth = new Date().getDate(),
): RecurrencePickerState {
	return {
		frequency: rule?.frequency ?? 'daily',
		interval: rule?.interval ?? 1,
		daysOfWeek: rule?.daysOfWeek ?? [],
		dayOfMonth: rule?.dayOfMonth ?? defaultDayOfMonth,
		hour: rule?.hour ?? 9,
		minute: rule?.minute ?? 0,
		...(rule?.second ? { second: rule.second } : {}),
		...(rule?.millisecond ? { millisecond: rule.millisecond } : {}),
	};
}

export function buildRecurrencePickerDraft(rule: RecurrenceRule | undefined): RecurrencePickerDraft {
	const { hour, minute, ...state } = buildRecurrencePickerState(rule);
	return { ...state, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

/** Compare only the controls that affect the selected frequency. */
export function isRecurrencePickerStateUnchanged(current: RecurrencePickerState, initial: RecurrencePickerState): boolean {
	if (current.frequency !== initial.frequency || current.interval !== initial.interval
		|| current.hour !== initial.hour || current.minute !== initial.minute
		|| (current.second ?? 0) !== (initial.second ?? 0)
		|| (current.millisecond ?? 0) !== (initial.millisecond ?? 0)) return false;
	if (current.frequency === 'monthly') return current.dayOfMonth === initial.dayOfMonth;
	if (current.frequency === 'weekly') {
		return current.daysOfWeek.length === initial.daysOfWeek.length
			&& current.daysOfWeek.every(day => initial.daysOfWeek.includes(day));
	}
	return true;
}

export function recurrenceRuleFromPickerState(state: RecurrencePickerState, timezone?: string): RecurrenceRule {
	const rule: RecurrenceRule = {
		frequency: state.frequency,
		hour: state.hour,
		minute: state.minute,
		...(state.second ? { second: state.second } : {}),
		...(state.millisecond ? { millisecond: state.millisecond } : {}),
		...(timezone ? { timezone } : {}),
	};
	if (state.interval > 1) rule.interval = state.interval;
	if (state.frequency === 'weekly' && state.daysOfWeek.length > 0) {
		rule.daysOfWeek = state.daysOfWeek;
	}
	if (state.frequency === 'monthly') {
		rule.dayOfMonth = state.dayOfMonth;
	}
	return normalizeRecurrenceRule(rule) ?? rule;
}

export function recurrenceRuleFromPickerDraft(draft: RecurrencePickerDraft, timezone?: string): RecurrenceRule {
	const [rawHour = 9, rawMinute = 0] = draft.time.split(':').map(Number);
	const hour = Number.isInteger(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9;
	const minute = Number.isInteger(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;
	return recurrenceRuleFromPickerState({
		frequency: draft.frequency,
		interval: draft.interval,
		daysOfWeek: draft.daysOfWeek,
		dayOfMonth: Math.min(31, Math.max(1, draft.dayOfMonth)),
		hour,
		minute,
		second: draft.second,
		millisecond: draft.millisecond,
	}, timezone);
}

export function summarizeRecurrencePickerState(
	state: RecurrencePickerState,
	locale = getUiLocale(),
): string {
	const timeStr = formatRecurrenceTime(state.hour, state.minute, locale);
	switch (state.frequency) {
		case 'daily':
			if (state.interval > 1) return `Every ${state.interval} days at ${timeStr}`;
			return `Daily at ${timeStr}`;
		case 'weekly': {
			const base = state.interval === 1 ? 'Weekly' : `Every ${state.interval} weeks`;
			if (state.daysOfWeek.length === 0) return `${base} at ${timeStr}`;
			const localizedDayNames = getRecurrenceDayNames(locale, 'short');
			const dayNames = state.daysOfWeek.map((day) => localizedDayNames[day]).join(', ');
			return `${base} on ${dayNames} at ${timeStr}`;
		}
		case 'monthly': {
			const base = state.interval === 1 ? 'Monthly' : `Every ${state.interval} months`;
			return `${base} on the ${getOrdinalSuffix(state.dayOfMonth)} at ${timeStr}`;
		}
	}
}
