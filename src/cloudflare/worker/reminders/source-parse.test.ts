import { expect, it } from 'vitest';
import { DUPLICATE_COMMITTED_REMINDER_ISSUE, parseReminderSource, REMINDER_PROJECTION_SIZE_ISSUE, reminderSourceIssueCode } from './source-parse';
import { ReminderIdentityConflictError } from './source-identity';

it('parses ordinary reminders even when a plaintext note starts with encryption framing', () => {
	const text = 'CRATE-E2EE/1\nExample format documentation\n- [ ] Call the office <!-- crate-id:call -->';
	expect(parseReminderSource('Reminders/Inbox.md', text, 'Reminders')).toMatchObject({ reminders: [{ id: 'call', content: 'Call the office' }] });
	// A vault explicitly known to be encrypted still rejects that same content.
	const encrypted = parseReminderSource('Reminders/Inbox.md', text, 'Reminders', true);
	expect(encrypted.reminders).toEqual([]);
	expect(encrypted.issue).toContain('invalid');
});

it.each([
	['an unsupported description', '- [ ] Task <!-- crate-id:a -->\n<!-- crate-desc:v2:x -->', { code: 'unsupported-description-encoding', line: 2 }],
	['a broken description', '- [ ] Task <!-- crate-id:a -->\n<!-- crate-desc:unfinished', { code: 'invalid-description-block', line: 2 }],
	['a non-UTF-8 note', new Uint8Array([0x2d, 0x20, 0xc3, 0x28]).buffer, { code: 'invalid-markdown-encoding' }],
	['an oversized note', 'x'.repeat(1024 * 1024 + 1), { code: 'reminder-note-too-large' }],
])('records a stable code for %s', (_name, content, expected) => {
	const { issue } = parseReminderSource('Reminders/Inbox.md', content, 'Reminders');
	expect(reminderSourceIssueCode(issue!)).toEqual(expected);
});

it('codes projection failures written here and leaves other failures uncoded', () => {
	expect(reminderSourceIssueCode(REMINDER_PROJECTION_SIZE_ISSUE)).toEqual({ code: 'reminder-note-too-large' });
	expect(reminderSourceIssueCode(DUPLICATE_COMMITTED_REMINDER_ISSUE)).toEqual({ code: 'duplicate-reminder-id' });
	expect(reminderSourceIssueCode(new ReminderIdentityConflictError().message)).toEqual({ code: 'duplicate-reminder-id' });
	expect(reminderSourceIssueCode('Committed reminder content could not be verified')).toBeUndefined();
});
