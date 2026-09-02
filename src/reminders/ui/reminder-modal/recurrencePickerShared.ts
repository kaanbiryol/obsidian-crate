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
		minute: '2-digit',
	}).format(new Date(2021, 7, 1, hour, minute));
}

export interface RecurrencePickerState {
	frequency: RecurrenceRule['frequency'];
	interval: number;
	daysOfWeek: number[];
	dayOfMonth: number;
	hour: number;
	minute: number;
}

export interface RecurrencePickerDraft {
	frequency: RecurrenceRule['frequency'];
	interval: number;
	daysOfWeek: number[];
	dayOfMonth: number;
	time: string;
}

export function getOrdinalSuffix(value: number): string {
	if (value === -1) return 'Last';
	const endings = ['th', 'st', 'nd', 'rd'];
	const mod = value % 100;
	return `${value}${endings[(mod - 20) % 10] || endings[mod] || endings[0]}`;
}

export function buildRecurrencePickerDraft(rule: RecurrenceRule | undefined): RecurrencePickerDraft {
	return {
		frequency: rule?.frequency ?? 'daily',
		interval: rule?.interval ?? 1,
		daysOfWeek: rule?.daysOfWeek ?? [],
		dayOfMonth: rule?.dayOfMonth ?? new Date().getDate(),
		time: `${String(rule?.hour ?? 9).padStart(2, '0')}:${String(rule?.minute ?? 0).padStart(2, '0')}`,
	};
}

export function recurrenceRuleFromPickerState(state: RecurrencePickerState): RecurrenceRule {
	const rule: RecurrenceRule = {
		frequency: state.frequency,
		hour: state.hour,
		minute: state.minute,
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

export function recurrenceRuleFromPickerDraft(draft: RecurrencePickerDraft): RecurrenceRule {
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
	});
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
