import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatLocalDateKey } from '../core/dates/reminderDate';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { EditorSelection, EditorState } from '@codemirror/state';
import { editableDatePhrase, reminderDateDisplay } from './reminder-date-display';
import { createReminderDateChips, datePhraseField, leavePhrase, openDateChip } from '../editor/editor-date-chips';

/** A minute in local time within three years of `now`, including DST changes, month ends and leap days. */
const local = fc.record({
	days: fc.integer({ min: -400, max: 1100 }),
	hour: fc.integer({ min: 0, max: 23 }),
	minute: fc.integer({ min: 0, max: 59 }),
	hasTime: fc.boolean(),
});
const now = fc.date({ min: new Date('2025-01-01T00:00:00Z'), max: new Date('2028-12-31T00:00:00Z'), noInvalidDate: true });
const prefix = fc.constantFrom('- [ ] ', '- [x] ', '    - [ ] ', '\t- [ ] ');
const title = fc.constantFrom('Call Mia', 'Pay rent', 'Read chapter 3', 'Ünïcode task', 'Ship v2.0');
const tail = fc.constantFrom('', ' <!-- crate-id:a -->', ' // a note <!-- crate-id:a -->');

const stored = (base: Date, { days, hour, minute, hasTime }: { days: number; hour: number; minute: number; hasTime: boolean }) => {
	const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, minute);
	return hasTime ? date.toISOString() : formatLocalDateKey(date);
};

describe('date phrases', () => {
	// Saving reads the clock, so each run sets it to that run's day.
	beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }));
	afterAll(() => vi.useRealTimers());

	it('offers a phrase for every saved date with minute precision, which saves back to the same line', () => {
		fc.assert(fc.property(now, local, prefix, title, tail, (today, when, start, name, end) => {
			vi.setSystemTime(today);
			const date = stored(today, when);
			// A time that does not exist on a DST change day is saved as the next valid time; skip those.
			if (when.hasTime && new Date(date).getHours() !== when.hour) return;
			const line = `${start}${name} ${date}${end}`;
			if (reminderDateDisplay(line, today)?.kind !== 'chip') return;
			const editable = editableDatePhrase(line, today);
			expect(editable, line).not.toBeNull();
			expect(line.slice(editable!.from, editable!.to)).toBe(date);
			// Never the stored UTC form; a local `YYYY-MM-DD` is the readable last resort.
			expect(editable!.phrase).not.toMatch(/T\d{2}:|Z|\.\d{3}/);
			const edited = line.slice(0, editable!.from) + editable!.phrase + line.slice(editable!.to);
			// Only the schedule is checked: a typed description after it would also move on save.
			expect(normalizeReminderScheduleLine(edited.replace(/ \/\/ a note/, ''))).toBe(line.replace(/ \/\/ a note/, ''));
		}), { numRuns: 2000 });
	}, 60_000);

	it('never offers a phrase that saves a different date', () => {
		fc.assert(fc.property(now, local, (today, when) => {
			vi.setSystemTime(today);
			const line = `- [ ] Task ${stored(today, when)} <!-- crate-id:a -->`;
			const editable = editableDatePhrase(line, today);
			if (!editable) return;
			const edited = line.slice(0, editable.from) + editable.phrase + line.slice(editable.to);
			expect(normalizeReminderScheduleLine(edited)).toBe(line);
		}), { numRuns: 1000 });
	});

	it('restores the note exactly when a phrase opened by the cursor is left unchanged', () => {
		const extensions = createReminderDateChips(() => true, () => undefined);
		fc.assert(fc.property(now, local, prefix, fc.boolean(), (today, when, start, fromAfter) => {
			vi.setSystemTime(today);
			const doc = `Intro\n${start}Task ${stored(today, when)} <!-- crate-id:a -->\nOutro`;
			const editable = editableDatePhrase(doc.split('\n')[1]!, today);
			if (!editable) return;
			const lineFrom = doc.indexOf('\n') + 1, at = lineFrom + (fromAfter ? editable.to : editable.from);
			const state = EditorState.create({ doc, selection: { anchor: at }, extensions });
			const opened = state.update(openDateChip(state, EditorSelection.single(fromAfter ? at + 1 : at - 1), today)!).state;
			expect(opened.doc.line(2).text).toBe(`${start}Task ${editable.phrase} <!-- crate-id:a -->`);
			const left = opened.update({ changes: leavePhrase(opened, opened.field(datePhraseField)!).changes }).state;
			expect(left.doc.toString()).toBe(doc);
		}), { numRuns: 800 });
	});
});
