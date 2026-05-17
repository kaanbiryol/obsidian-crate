import type { RecurrenceRule } from '../../types';
import { normalizeRecurrenceRule } from '../../utils/recurrenceRule';

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export const RECURRENCE_DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
export const RECURRENCE_DAY_FULL_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceRule['frequency'], string> = {
	daily: 'Daily',
	weekly: 'Weekly',
	monthly: 'Monthly',
};

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
	const [rawHour, rawMinute] = draft.time.split(':').map(Number);
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

export function summarizeRecurrencePickerState(state: RecurrencePickerState): string {
	const timeStr = `${state.hour.toString().padStart(2, '0')}:${state.minute.toString().padStart(2, '0')}`;
	switch (state.frequency) {
		case 'daily':
			if (state.interval > 1) return `Every ${state.interval} days at ${timeStr}`;
			return `Daily at ${timeStr}`;
		case 'weekly': {
			if (state.daysOfWeek.length === 0) return `Weekly at ${timeStr}`;
			if (state.daysOfWeek.length === 7) return `Every day at ${timeStr}`;
			const dayNames = state.daysOfWeek.map((day) => RECURRENCE_DAY_FULL_NAMES[day]).join(', ');
			return `${dayNames} at ${timeStr}`;
		}
		case 'monthly':
			return `${getOrdinalSuffix(state.dayOfMonth)} of month at ${timeStr}`;
	}
}
