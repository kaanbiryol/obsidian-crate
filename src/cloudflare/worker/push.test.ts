import { describe, expect, it } from 'vitest';
import { createDeclarativePushPayload } from './push';

describe('createDeclarativePushPayload', () => {
	it('creates an iOS declarative web push payload with a reminder deep link', () => {
		expect(createDeclarativePushPayload({
			title: 'Review release notes',
			body: 'Shipping',
			tag: 'reminder-123',
			project: 'Shipping',
			reminderId: 'reminder-123',
		})).toEqual({
			web_push: 8030,
			notification: {
				title: 'Review release notes',
				body: 'Shipping',
				navigate: '/notifications?project=Shipping&reminderId=reminder-123',
				tag: 'reminder-123',
				icon: '/notifications/crate-icon-192.png',
				data: {
					project: 'Shipping',
					reminderId: 'reminder-123',
				},
			},
		});
	});

	it('omits optional fields and opens the app root when there is no reminder context', () => {
		expect(createDeclarativePushPayload({
			title: 'Test notification',
			body: 'Push notifications are working.',
		})).toMatchObject({
			web_push: 8030,
			notification: {
				navigate: '/notifications',
				data: { project: '', reminderId: '' },
			},
		});
		expect(createDeclarativePushPayload({ title: 'Test', body: '' }).notification).not.toHaveProperty('tag');
	});
});
