import { expect, it } from 'vitest';
import { extractReminderId, findReminderIdMarker, setReminderIdMarker, stripReminderIdMarker } from './reminderIdentity';

it('reads hyphenated markers in linear time, even when other text follows them', () => {
	const id = Array.from({ length: 24 }, (_, index) => `s${index}`).join('-');
	const started = performance.now();
	expect(extractReminderId(`- [ ] Task <!-- crate-id:${id} --> trailing text`)).toBe(id);
	expect(stripReminderIdMarker(`- [ ] Task <!-- crate-id:${id} --> trailing text`)).toBe('- [ ] Task trailing text');
	// The previous pattern backtracked exponentially here: about 0.7 s per call.
	expect(performance.now() - started).toBeLessThan(250);
	expect(extractReminderId(`- [ ] Task <!-- crate-id:${id} -->`)).toBe(id);
	expect(stripReminderIdMarker(`- [ ] Task <!-- crate-id:${id} -->`)).toBe('- [ ] Task');
});

it('scans long whitespace runs in linear time', () => {
	const spaces = ' '.repeat(100_000);
	const started = performance.now();
	expect(extractReminderId(`- [ ] Task${spaces}x`)).toBeNull();
	expect(stripReminderIdMarker(`- [ ] Task${spaces}x`)).toBe(`- [ ] Task${spaces}x`);
	// The previous leading whitespace match backtracked quadratically: about 17 s here.
	expect(performance.now() - started).toBeLessThan(250);
	expect(stripReminderIdMarker(`- [ ] Task${spaces}<!-- crate-id:abc -->${spaces}`)).toBe('- [ ] Task');
	expect(extractReminderId(`- [ ] Task${spaces}<!-- crate-id:abc -->`)).toBe('abc');
});

it('keeps a marker pushed off the line end and moves it back on write', () => {
	const line = '- [ ] Buy milk <!-- crate-id:a --> tomorrow';
	expect(extractReminderId(line)).toBe('a');
	expect(setReminderIdMarker(line, 'a')).toBe('- [ ] Buy milk tomorrow <!-- crate-id:a -->');
	expect(line.slice(findReminderIdMarker(line)!.from, findReminderIdMarker(line)!.to)).toBe(' <!-- crate-id:a -->');
});

it('keeps the first marker of joined lines and drops the rest', () => {
	const joined = '- [ ] A <!-- crate-id:a -->- [ ] B <!-- crate-id:b -->';
	expect(extractReminderId(joined)).toBe('a');
	expect(setReminderIdMarker(joined, 'a')).toBe('- [ ] A- [ ] B <!-- crate-id:a -->');
});
