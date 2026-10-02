import { expect, it } from 'vitest';
import { parseReminderSource } from './reminder-source-parse';

it('parses ordinary reminders even when a plaintext note starts with encryption framing', () => {
	const text = 'CRATE-E2EE/1\nExample format documentation\n- [ ] Call the office <!-- crate-id:call -->';
	expect(parseReminderSource('Reminders/Inbox.md', text, 'Reminders')).toMatchObject({ reminders: [{ id: 'call', content: 'Call the office' }] });
	// A vault explicitly known to be encrypted still rejects that same content.
	const encrypted = parseReminderSource('Reminders/Inbox.md', text, 'Reminders', true);
	expect(encrypted.reminders).toEqual([]);
	expect(encrypted.issue).toContain('invalid');
});
