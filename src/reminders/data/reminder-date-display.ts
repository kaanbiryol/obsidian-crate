import { parseCheckboxLine, type ParsedCheckbox } from '../core/grammar/checkboxParser';
import { UnresolvedReminderScheduleError } from '../core/grammar/reminderParser';
import { findAllMatches } from '../core/grammar/richTextMatchers';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { isReminderOverdue, isStoredReminderDate, isStoredReminderDatetime } from '../core/dates/reminderDate';
import { formatDueDate } from '../ui/format/dateFormatting';

/**
 * How a reminder line's schedule shows in a note, relative to the line's start:
 * a saved date as a chip, a typed phrase with the date saving will write, or a
 * phrase that cannot become a date with the parser's error.
 */
export type ReminderDateDisplay =
	| { kind: 'chip'; from: number; to: number; label: string; overdue: boolean }
	| { kind: 'phrase'; from: number; to: number; label: string }
	| { kind: 'error'; from: number; to: number; message: string };

const TASK_WITH_TEXT = /^\s*-\s*\[[ xX]\]\s*\S/;

/**
 * Where the schedule the parser takes from a checkbox's content sits in its line:
 * the last date match, found by the same matcher the reminder editor highlights with.
 */
function scheduleRange(text: string, content: string, now: Date) {
	const offset = text.indexOf(content);
	const match = findAllMatches(content, undefined, now).filter(found => found.type === 'date').at(-1);
	return offset === -1 || !match ? null : { from: offset + match.index, to: offset + match.index + match.length, match };
}

function savedChip(text: string, checkbox: ParsedCheckbox, now: Date): ReminderDateDisplay | null {
	const { datePart, recurrencePart, recurrence } = checkbox.parsed;
	// Only the canonical stored text: anything else is still being written and stays as typed.
	if (!datePart || datePart === recurrencePart) return null;
	const hasTime = isStoredReminderDatetime(datePart);
	if (!hasTime && !isStoredReminderDate(datePart)) return null;
	const range = scheduleRange(text, checkbox.rawContent, now);
	const label = formatDueDate(datePart, undefined, now, recurrence);
	if (!range || range.match.text !== datePart || !label) return null;
	const overdue = isReminderOverdue({ ...hasTime ? { dueDatetime: datePart } : { dueDate: datePart }, completed: checkbox.isCompleted }, now);
	return { kind: 'chip', from: range.from, to: range.to, label, overdue };
}

function typedSchedule(text: string, now: Date): ReminderDateDisplay | null {
	const checkbox = parseCheckboxLine(text);
	const range = checkbox && scheduleRange(text, checkbox.rawContent, now);
	if (!checkbox || !range) return null;
	const { dateError } = checkbox.parsed;
	if (dateError) return range.match.invalid ? { kind: 'error', from: range.from, to: range.to, message: dateError } : null;
	let saved: string;
	try { saved = normalizeReminderScheduleLine(text); } catch { return null; }
	const display = saved === text ? null : reminderDateDisplay(saved, now);
	return display?.kind === 'chip' ? { kind: 'phrase', from: range.from, to: range.to, label: display.label } : null;
}

/** A reminder line's schedule display, or null for lines without one. */
export function reminderDateDisplay(text: string, now = new Date()): ReminderDateDisplay | null {
	if (!TASK_WITH_TEXT.test(text)) return null;
	let checkbox: ParsedCheckbox | null;
	try {
		checkbox = parseCheckboxLine(text, { persisted: true });
	} catch (error) {
		// A schedule the scan has not saved yet: typed natural language or an invalid date.
		return error instanceof UnresolvedReminderScheduleError ? typedSchedule(text, now) : null;
	}
	return checkbox && savedChip(text, checkbox, now);
}

/**
 * A saved date chip that runs `activate` when selected. Presses never reach the
 * editor: the browser would place its cursor beside the chip, which shows the
 * line's text and removes the chip before the click arrives.
 */
export function createReminderDateChip(label: string, overdue: boolean, activate: (element: HTMLElement) => void): HTMLElement {
	const element = createSpan({ cls: ['crate-reminder-date', ...overdue ? ['is-overdue'] : []], text: label, attr: { role: 'button' } });
	element.addEventListener('mousedown', event => event.preventDefault());
	element.addEventListener('click', event => {
		event.preventDefault();
		activate(element);
	});
	// A tap moves the cursor on touch end, also before the click; a drag scrolls.
	let start: { x: number; y: number } | null = null;
	element.addEventListener('touchstart', event => {
		const touch = event.touches[0];
		start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
	}, { passive: true });
	element.addEventListener('touchend', event => {
		const touch = event.changedTouches[0];
		if (!start || !touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) return;
		start = null;
		event.preventDefault();
		activate(element);
	});
	return element;
}
