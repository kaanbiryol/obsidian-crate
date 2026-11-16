import { parseCheckboxLine, type ParsedCheckbox } from '../core/grammar/checkboxParser';
import { UnresolvedReminderScheduleError } from '../core/grammar/reminderParser';
import { findAllMatches } from '../core/grammar/richTextMatchers';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { formatLocalDateKey, isReminderOverdue, isStoredReminderDate, isStoredReminderDatetime, parseReminderDateValue } from '../core/dates/reminderDate';
import { formatDueDate } from '../ui/format/dateFormatting';
import { inlineDescription } from './inline-description';

/**
 * How a reminder line's schedule shows in a note, relative to the line's start:
 * a saved date as a chip, a typed phrase with the date saving will write, or a
 * phrase that cannot become a date with the parser's error, and a description
 * typed after ` //` that leaving the line moves under the reminder.
 */
export type ReminderDateDisplay =
	| { kind: 'chip'; from: number; to: number; label: string; overdue: boolean; typed?: true }
	| { kind: 'phrase'; from: number; to: number; label: string; overdue: boolean }
	| { kind: 'error'; from: number; to: number; message: string }
	| { kind: 'description'; from: number; start: number; to: number; breaks: number[] }
	| { kind: 'important'; from: number; to: number };

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
	return display?.kind === 'chip' ? { kind: 'phrase', from: range.from, to: range.to, label: display.label, overdue: display.overdue } : null;
}

/** A reminder line's schedule display, or null for lines without one. A typed description's dates are not its schedule. */
export function reminderDateDisplay(line: string, now = new Date()): ReminderDateDisplay | null {
	if (!TASK_WITH_TEXT.test(line)) return null;
	const description = inlineDescription(line), text = description ? line.slice(0, description.from) : line;
	let checkbox: ParsedCheckbox | null;
	try {
		checkbox = parseCheckboxLine(text, { persisted: true });
	} catch (error) {
		// A schedule the scan has not saved yet: typed natural language or an invalid date.
		return error instanceof UnresolvedReminderScheduleError ? typedSchedule(text, now) : null;
	}
	return checkbox && savedChip(text, checkbox, now);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * English phrases the date parser reads as `date`, shortest first. The local
 * `YYYY-MM-DD` form comes last: past dates are only read in that form.
 */
function datePhrases(date: Date, hasTime: boolean, now: Date): string[] {
	const relative = (days: number) => {
		const day = new Date(now);
		day.setDate(day.getDate() + days);
		return formatLocalDateKey(day);
	};
	const key = formatLocalDateKey(date), day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	const named = key === relative(0) ? ['today'] : key === relative(1) ? ['tomorrow'] : key === relative(-1) ? ['yesterday'] : [];
	const days = [...named, day, `${day} ${date.getFullYear()}`, key];
	const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	return days.map(text => hasTime ? `${text} ${time}` : text);
}

/**
 * A saved date's chip range and a phrase to edit in its place, which saving
 * turns back into exactly the same line; null when no phrase does, as for some
 * repeat rules.
 */
export function editableDatePhrase(text: string, now = new Date()): { from: number; to: number; phrase: string } | null {
	const display = reminderDateDisplay(text, now);
	if (display?.kind !== 'chip') return null;
	const stored = text.slice(display.from, display.to), hasTime = isStoredReminderDatetime(stored);
	const date = parseReminderDateValue(stored, hasTime);
	if (!date) return null;
	// Saving moves a typed description under the reminder first, so a phrase must give the date without it too.
	const withoutDescription = (line: string) => {
		const typed = inlineDescription(line);
		return typed ? line.slice(0, typed.from) + line.slice(typed.to) : line;
	};
	for (const phrase of datePhrases(date, hasTime, now)) {
		const edited = text.slice(0, display.from) + phrase + text.slice(display.to), bare = withoutDescription(edited);
		try {
			if (normalizeReminderScheduleLine(edited) === text && (bare === edited || normalizeReminderScheduleLine(bare) === withoutDescription(text))) {
				return { from: display.from, to: display.to, phrase };
			}
		} catch { /* Not a phrase the parser takes; try a longer one. */ }
	}
	return null;
}

/**
 * Where a task line's important marker sits: the last standalone `!` in its
 * title, the one the parser reads, found by the same matcher. Null without one.
 */
export function importantMarker(line: string): { from: number; to: number } | null {
	const task = TASK_WITH_TEXT.exec(line);
	if (!task) return null;
	const start = task[0].length - 1, end = inlineDescription(line)?.from ?? line.length;
	const match = findAllMatches(line.slice(start, end)).filter(found => found.type === 'priority').at(-1);
	return match ? { from: start + match.index, to: start + match.index + match.length } : null;
}

/** A reminder line's schedule display, important marker and typed description, in line order. */
export function reminderLineDisplays(text: string, now = new Date()): ReminderDateDisplay[] {
	const schedule = reminderDateDisplay(text, now), description = TASK_WITH_TEXT.test(text) ? inlineDescription(text) : null;
	const important = importantMarker(text);
	return [
		...schedule ? [schedule] : [],
		...important ? [{ kind: 'important' as const, ...important }] : [],
		...description ? [{ kind: 'description' as const, from: description.from, start: description.start, to: description.to, breaks: description.breaks }] : [],
	].sort((a, b) => a.from - b.from);
}

/** An important marker shown as a chip, keeping its `!` as the text. */
export function createImportantChip(): HTMLElement {
	return createSpan({ cls: ['crate-reminder-important'], text: '!' });
}

/** A saved date chip that runs `activate` when selected. */
export function createReminderDateChip(label: string, overdue: boolean, activate: (element: HTMLElement) => void): HTMLElement {
	return pressable(createSpan({ cls: ['crate-reminder-date', ...overdue ? ['is-overdue'] : []], text: label, attr: { role: 'button' } }), activate);
}

/**
 * Runs `activate` when `element` is selected. Presses never reach the editor:
 * the browser would place its cursor beside the element, which shows the line's
 * text and removes the element before the click arrives.
 */
function pressable(element: HTMLElement, activate: (element: HTMLElement) => void): HTMLElement {
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
