import { validateRecurrence } from './validateRecurrence';
import type { RecurrenceRule } from '../types/reminder';
import { recurrenceToText } from '../utils/rruleConverter';
import { normalizeRecurrenceRule } from '../utils/recurrenceRule';

const MARKER = /\s*<!-- crate-rule:([^>]*?) -->/g;

export function appendRecurrenceMetadata(content: string, recurrence?: RecurrenceRule): string {
	if (!recurrence) return content;
	return `${content} <!-- crate-rule:${encodeURIComponent(JSON.stringify(normalizeRecurrenceRule(recurrence))).replace(/-/g, '%2D')} -->`;
}

export function readRecurrenceMetadata(content: string): { content: string; recurrence?: RecurrenceRule } {
	let recurrence: RecurrenceRule | undefined;
	const stripped = content.replace(MARKER, (_marker, encoded: string) => {
		try {
			const raw: unknown = JSON.parse(decodeURIComponent(encoded));
			const result = validateRecurrence(raw);
			if ('rule' in result) recurrence = result.rule;
		} catch { /* Invalid metadata never replaces the readable rule. */ }
		return '';
	});
	// A manual rule edit invalidates its old machine metadata. Title edits do not.
	if (recurrence && !stripped.includes(recurrenceToText(recurrence))) recurrence = undefined;
	return { content: stripped.trimEnd(), recurrence };
}
