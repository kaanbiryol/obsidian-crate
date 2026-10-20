import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCheckboxLine } from './checkboxParser';
import { parseReminderContent, UnresolvedReminderScheduleError } from './reminderParser';

vi.mock('./reminderParser', async importOriginal => {
	const actual = await importOriginal<typeof import('./reminderParser')>();
	return { ...actual, parseReminderContent: vi.fn(actual.parseReminderContent) };
});

const originalTimezone = process.env.TZ;
afterEach(() => {
	if (originalTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimezone;
	vi.mocked(parseReminderContent).mockClear();
});

describe('persisted checkbox parse cache', () => {
	it('reuses unchanged lines and hands out independent results', () => {
		const line = '- [ ] Cached task Nov 20, 2026 <!-- crate-id:rem-cache -->';
		const first = parseCheckboxLine(line, { persisted: true })!;
		first.parsed.cleanContent = 'mutated';
		first.parsed.dueDate!.setFullYear(1999);
		const second = parseCheckboxLine(line, { persisted: true })!;

		expect(vi.mocked(parseReminderContent)).toHaveBeenCalledTimes(1);
		expect(second.parsed.cleanContent).toBe('Cached task');
		expect(second.parsed.dueDate!.getFullYear()).toBe(2026);
	});

	it('remembers unresolved schedules without caching draft parses', () => {
		const line = '- [ ] Unresolved task tomorrow';
		expect(() => parseCheckboxLine(line, { persisted: true })).toThrow(UnresolvedReminderScheduleError);
		expect(() => parseCheckboxLine(line, { persisted: true })).toThrow(UnresolvedReminderScheduleError);
		expect(vi.mocked(parseReminderContent)).toHaveBeenCalledTimes(1);

		expect(parseCheckboxLine(line)?.parsed.dueDate).toBeInstanceOf(Date);
		expect(parseCheckboxLine(line)?.parsed.dueDate).toBeInstanceOf(Date);
		expect(vi.mocked(parseReminderContent)).toHaveBeenCalledTimes(3);
	});

	it('parses again after the local timezone changes', () => {
		const line = '- [ ] Zoned task Nov 20, 2026 <!-- crate-id:rem-zone -->';
		process.env.TZ = 'Europe/Athens';
		const athens = parseCheckboxLine(line, { persisted: true })!.parsed.dueDate!;
		process.env.TZ = 'Europe/Istanbul';
		const istanbul = parseCheckboxLine(line, { persisted: true })!.parsed.dueDate!;

		expect(vi.mocked(parseReminderContent)).toHaveBeenCalledTimes(2);
		expect(istanbul.getTime() - athens.getTime()).toBe(-60 * 60_000);
	});
});
