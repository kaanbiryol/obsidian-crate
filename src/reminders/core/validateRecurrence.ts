import type { RecurrenceRule } from '../types/reminder';
import { normalizeRecurrenceRule } from '../utils/recurrenceRule';

export function validateRecurrence(value: unknown): { rule: RecurrenceRule } | { error: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid recurrence' };
	const raw = value as Record<string, unknown>;
	if (raw.frequency !== 'daily' && raw.frequency !== 'weekly' && raw.frequency !== 'monthly') return { error: 'Invalid recurrence frequency' };
	const rule: RecurrenceRule = { frequency: raw.frequency };
	for (const [field, min, max] of [
		['interval', 1, 365], ['dayOfMonth', 1, 31], ['hour', 0, 23], ['minute', 0, 59],
		['count', 1, Number.MAX_SAFE_INTEGER], ['completedCount', 0, Number.MAX_SAFE_INTEGER],
	] as const) {
		const number = raw[field];
		if (number === undefined) continue;
		if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) return { error: `Invalid recurrence ${field}` };
		rule[field] = number;
	}
	if (raw.daysOfWeek !== undefined) {
		if (!Array.isArray(raw.daysOfWeek) || raw.daysOfWeek.length > 7 || raw.daysOfWeek.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return { error: 'Invalid recurrence daysOfWeek' };
		rule.daysOfWeek = [...new Set(raw.daysOfWeek as number[])].sort((a, b) => a - b);
	}
	if (raw.timezone !== undefined) {
		if (typeof raw.timezone !== 'string' || !raw.timezone.trim()) return { error: 'Invalid recurrence timezone' };
		try { new Intl.DateTimeFormat('en', { timeZone: raw.timezone }).format(); }
		catch { return { error: 'Invalid recurrence timezone' }; }
		rule.timezone = raw.timezone;
	}
	if (raw.endDate !== undefined) {
		const date = raw.endDate;
		if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date.slice(0, 10)).toISOString().slice(0, 10) !== date.slice(0, 10)) return { error: 'Invalid recurrence end date' };
		rule.endDate = date;
	}
	return { rule: normalizeRecurrenceRule(rule) };
}
