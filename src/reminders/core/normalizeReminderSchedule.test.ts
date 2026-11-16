import { afterEach, expect, it, vi } from 'vitest';
import { normalizeReminderScheduleLine } from './normalizeReminderSchedule';

afterEach(() => { vi.useRealTimers(); });

it('leaves a stored date joined to a word as text, so saving again changes nothing', () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-14T11:00:00.000Z'));
	// Deleting the space before a saved date joins it to the title; its clock is not a new time.
	for (const line of [
		'- [ ] Timed2026-11-15T11:00:00.000Z <!-- crate-id:c -->',
		'- [ ] Room2026-11-15 <!-- crate-id:d -->',
	]) expect(normalizeReminderScheduleLine(line)).toBe(line);
});

it('keeps the space between a saved date and the text after it', () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-14T11:00:00.000Z'));
	// The important marker reads only as its own word, so joining it to the date would drop it.
	expect(normalizeReminderScheduleLine('- [ ] Eat Nov 19 !')).toBe('- [ ] Eat 2026-11-19 !');
	expect(normalizeReminderScheduleLine('- [ ] Eat Nov 19 ! <!-- crate-id:a -->')).toBe('- [ ] Eat 2026-11-19 ! <!-- crate-id:a -->');
	expect(normalizeReminderScheduleLine('- [ ] Ship v2.0 Feb 1')).toBe('- [ ] Ship v2.0 2027-02-01');
});
