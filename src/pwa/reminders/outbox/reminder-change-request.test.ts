import { expect, it, vi } from 'vitest';
import { ExpiredReminderChange, RejectedReminderChange, submitReminderChange } from './reminder-change-request';
import type { PendingReminderChange } from './reminder-outbox-types';

const reminder = { id: 'one', content: 'Task', project: 'Inbox', completed: false, priority: 4,
	filePath: 'Reminders/Inbox.md', revision: 'confirmed' };
const change: PendingReminderChange = { operationId: 'operation', recordId: 'one', kind: 'save',
	path: '/reminders/update', method: 'POST', body: '{}', status: 'pending', attempts: 0, retryAt: 0 };

it.each([
	{ dueDate: '2099-02-30' }, { dueDatetime: '2099-01-01T09:00:00' },
	{ recurrence: { frequency: 'weekly', timezone: 'Invalid/Zone' } },
	{ description: {} }, { filePath: 'Reminders/../Private.md' }, { revision: undefined }, { id: 'other' },
])('keeps an invalid acknowledgement uncertain: %j', async patch => {
	const api = vi.fn(async () => Response.json({ reminder: { ...reminder, ...patch } }));
	await expect(submitReminderChange(api, change)).rejects.toThrow('did not confirm this reminder');
});

it('keeps proxy pages out of the saved error and still recognizes server codes', async () => {
	const page = async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 });
	await expect(submitReminderChange(page, change)).rejects.toThrow(/^Could not sync this change\.$/);
	const expired = async () => Response.json({ error: 'This change expired.', code: 'operation_expired' }, { status: 410 });
	await expect(submitReminderChange(expired, change)).rejects.toThrow(ExpiredReminderChange);
	const rejected = async () => Response.json({ error: 'Reminder changed in Obsidian.' }, { status: 409 });
	await expect(submitReminderChange(rejected, change)).rejects.toThrow(RejectedReminderChange);
});

it('preserves confirmed extension fields without normalizing the receipt', async () => {
	const result = { reminder: { ...reminder, extension: 'preserved' }, notificationWarning: 'Push unavailable' };
	await expect(submitReminderChange(async () => Response.json(result), change)).resolves.toEqual(result);
});
