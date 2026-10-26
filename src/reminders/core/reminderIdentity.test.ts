import { expect, it } from 'vitest';
import { extractReminderId, stripReminderIdMarker } from './reminderIdentity';

it('reads hyphenated markers in linear time, even when other text follows them', () => {
	const id = Array.from({ length: 24 }, (_, index) => `s${index}`).join('-');
	const started = performance.now();
	expect(extractReminderId(`- [ ] Task <!-- crate-id:${id} --> trailing text`)).toBeNull();
	expect(stripReminderIdMarker(`- [ ] Task <!-- crate-id:${id} --> trailing text`)).toBe(`- [ ] Task <!-- crate-id:${id} --> trailing text`);
	// The previous pattern backtracked exponentially here: about 0.7 s per call.
	expect(performance.now() - started).toBeLessThan(250);
	expect(extractReminderId(`- [ ] Task <!-- crate-id:${id} -->`)).toBe(id);
	expect(stripReminderIdMarker(`- [ ] Task <!-- crate-id:${id} -->`)).toBe('- [ ] Task');
});
