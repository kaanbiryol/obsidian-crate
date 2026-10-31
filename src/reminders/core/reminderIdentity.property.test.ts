import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extractReminderId, setReminderIdMarker, stripReminderIdMarker } from './reminderIdentity';

const reminderId = fc.stringMatching(/^[A-Za-z0-9_-]{1,36}$/);
// Lines may already carry a marker, possibly an older one followed by whitespace.
const line = fc.tuple(
	fc.string({ maxLength: 30 }),
	fc.option(reminderId, { nil: undefined }),
	fc.constantFrom('', ' ', '  \t'),
	fc.boolean(),
).map(([text, existing, trailing, crlf]) =>
	`${text}${existing ? ` <!-- crate-id:${existing} -->` : ''}${trailing}${crlf ? '\r' : ''}`);

describe('reminder id markers', () => {
	it('reads back the id it writes and keeps the readable text', () => {
		fc.assert(fc.property(line, reminderId, (value, id) => {
			const marked = setReminderIdMarker(value, id);
			expect(extractReminderId(marked)).toBe(id);
			expect(stripReminderIdMarker(marked)).toBe(stripReminderIdMarker(value));
			expect(marked.endsWith('\r')).toBe(value.endsWith('\r'));
		}), { numRuns: 300 });
	});

	it('is idempotent, and a new id replaces the old one instead of adding a second', () => {
		fc.assert(fc.property(line, reminderId, reminderId, (value, first, second) => {
			const marked = setReminderIdMarker(value, first);
			expect(setReminderIdMarker(marked, first)).toBe(marked);
			expect(setReminderIdMarker(marked, second)).toBe(setReminderIdMarker(value, second));
		}), { numRuns: 300 });
	});
});
