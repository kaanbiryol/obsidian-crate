import { describe, expect, it } from 'vitest';
import { admittedProjectionJobs, notificationOperationFor } from './projection-plan';
import type { NotificationPolicy } from '../../../protocol/notification-policy';
import type { RemoteReminderRecord } from '../reminders/types';

const policy: NotificationPolicy = { folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00', revision: 'r1' };
const reminder = (overrides: Partial<RemoteReminderRecord> = {}): RemoteReminderRecord => ({
	id: 'a', content: 'Call', priority: 4, completed: false, project: 'Inbox',
	filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: '- [ ] Call', dueDatetime: '2099-01-02T10:00:00.000Z', ...overrides,
});
const due = Date.parse('2099-01-02T10:00:00.000Z');

describe('notificationOperationFor', () => {
	it('schedules an open reminder first seen before its due time', () => {
		expect(notificationOperationFor(reminder(), due - 1, policy)).toEqual({ id: 'a', operation: 'schedule', payload: {
			reminderId: 'a', content: 'Call', project: 'Inbox', dueDatetime: '2099-01-02T10:00:00.000Z',
		} });
	});

	it('schedules an all-day reminder at the policy time', () => {
		const operation = notificationOperationFor(reminder({ dueDatetime: undefined, dueDate: '2099-01-02' }), 0, policy);
		expect(operation.operation === 'schedule' && operation.payload.dueDatetime).toBe('2099-01-02T09:00:00.000Z');
	});

	it.each([
		['disabled notifications', reminder(), due, { ...policy, enabled: false }],
		['a completed reminder', reminder({ completed: true }), due, policy],
		['no due time', reminder({ dueDatetime: undefined }), due, { ...policy, allDayTime: null }],
		['a due time first seen after it passed', reminder(), due + 1, policy],
		['a reminder not yet observed', reminder(), null, policy],
	])('cancels for %s', (_case, value, firstSeenAt, current) => {
		expect(notificationOperationFor(value, firstSeenAt, current)).toEqual({ id: 'a', operation: 'cancel', payload: null });
	});
});

describe('admittedProjectionJobs', () => {
	it('admits leading jobs until the byte budget is spent', () => {
		expect(admittedProjectionJobs([40, 50, 20], 100, 100)).toBe(2);
		expect(admittedProjectionJobs([40, 60], 100, 100)).toBe(2);
		expect(admittedProjectionJobs([], 100, 100)).toBe(0);
	});

	it('counts oversized sources as free, since they fail without being read', () => {
		expect(admittedProjectionJobs([500, 90, 500, 20], 100, 100)).toBe(3);
	});

	it('stops at the first job that does not fit, keeping order', () => {
		expect(admittedProjectionJobs([90, 20, 5], 100, 100)).toBe(1);
	});
});
