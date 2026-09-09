import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	deserializeVapidKeys,
	generateVapidKeys,
	serializeVapidKeys,
} from 'web-push-browser';
import { createDeclarativePushPayload, getOrCreateVapidKeys, sendToAllSubscriptions } from './push';
import { createVapidAuthorizationToken, sendPushNotificationWithoutContact } from './notifications/web-push';

vi.mock('web-push-browser', async (importOriginal) => {
	const original = await importOriginal<typeof import('web-push-browser')>();
	return {
		...original,
		deserializeVapidKeys: vi.fn(),
		generateVapidKeys: vi.fn(),
		serializeVapidKeys: vi.fn(),
	};
});

vi.mock('./notifications/web-push', async (importOriginal) => {
	const original = await importOriginal<typeof import('./notifications/web-push')>();
	return {
		...original,
		sendPushNotificationWithoutContact: vi.fn(),
	};
});

beforeEach(() => {
	vi.clearAllMocks();
});

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
				navigate: '/notifications?reminderId=reminder-123',
				tag: 'reminder-123',
				icon: '/notifications/crate-icon-192.png',
				data: {
					project: '',
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

describe('createVapidAuthorizationToken', () => {
	it('omits the optional VAPID contact claim', async () => {
		const keyPair = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			true,
			['sign', 'verify'],
		);
		const token = await createVapidAuthorizationToken(
			keyPair.privateKey,
			new URL('https://push.example/subscription'),
		);
		const encodedPayload = token.split('.')[1];
		expect(encodedPayload).toBeDefined();
		const payloadJson = new TextDecoder().decode(
			new Uint8Array(Buffer.from(encodedPayload!, 'base64url')),
		);

		expect(payloadJson).toContain('"aud":"https://push.example"');
		expect(payloadJson).toMatch(/"exp":\d+/);
		expect(payloadJson).not.toContain('"sub"');
	});
});

describe('getOrCreateVapidKeys', () => {
	it('returns the persisted winner when concurrent initialization wins the insert race', async () => {
		vi.mocked(generateVapidKeys).mockResolvedValue({} as never);
		vi.mocked(serializeVapidKeys).mockResolvedValue({
			publicKey: 'generated-public',
			privateKey: 'generated-private',
		});
		let readCount = 0;
		const run = vi.fn(async () => ({ meta: { changes: 0 } }));
		const prepare = vi.fn((sql: string) => {
				const statement = {
					bind: vi.fn(() => statement),
					run,
					all: vi.fn(async () => {
						if (!sql.includes('SELECT public_key')) return { results: [] };
						readCount += 1;
						return readCount === 1
							? { results: [] }
							: { results: [{ public_key: 'winner-public', private_key: 'winner-private' }] };
					}),
				};
				return statement;
			});
		const db = { prepare } as unknown as D1Database;

		await expect(getOrCreateVapidKeys(db)).resolves.toEqual({
			publicKey: 'winner-public',
			privateKey: 'winner-private',
		});
		expect(run).toHaveBeenCalledOnce();
		expect(prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE'));
	});
});

describe('sendToAllSubscriptions', () => {
	it('never exceeds the Worker outgoing-connection concurrency limit', async () => {
		vi.mocked(deserializeVapidKeys).mockResolvedValue({} as never);
		let activeRequests = 0;
		let maximumActiveRequests = 0;
		vi.mocked(sendPushNotificationWithoutContact).mockImplementation(async () => {
			activeRequests += 1;
			maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
			await new Promise((resolve) => setTimeout(resolve, 1));
			activeRequests -= 1;
			return new Response(null, { status: 201 });
		});
		const subscriptions = Array.from({ length: 12 }, (_, index) => ({
			id: `subscription-${index}`,
			endpoint: `https://push.example/${index}`,
			p256dh: `p256dh-${index}`,
			auth: `auth-${index}`,
		}));
		const prepare = vi.fn((sql: string) => {
			const statement = {
				bind: vi.fn(() => statement),
				run: vi.fn(async () => ({})),
				all: vi.fn(async () => ({
					results: sql.includes('FROM push_subscriptions')
						? subscriptions
						: [{ public_key: 'public', private_key: 'private' }],
				})),
			};
			return statement;
		});

		const result = await sendToAllSubscriptions(
			{ prepare } as unknown as D1Database,
			{ title: 'Test', body: '' },
		);

		expect(result).toMatchObject({ sent: 12, failed: 0 });
		expect(maximumActiveRequests).toBe(6);
	});

	it.each([301, 302, 303, 307, 308, 403])('quarantines push status %i without retrying it', async (status) => {
		vi.mocked(deserializeVapidKeys).mockResolvedValue({} as never);
		vi.mocked(sendPushNotificationWithoutContact).mockResolvedValue(new Response('rejected', { status }));
		const run = vi.fn(async () => ({}));
		const prepare = vi.fn((sql: string) => {
			const statement = {
				bind: vi.fn(() => statement),
				run,
				all: vi.fn(async () => ({
					results: sql.includes('FROM push_subscriptions')
						? [{ id: 'bad-subscription', endpoint: 'https://push.example/bad', p256dh: 'key', auth: 'auth' }]
						: [{ public_key: 'public', private_key: 'private' }],
				})),
			};
			return statement;
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await sendToAllSubscriptions({ prepare } as unknown as D1Database, { title: 'Test', body: '' });

		expect(result).toMatchObject({ failed: 0, quarantined: 1, failedSubscriptionIds: [] });
		expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE push_subscriptions'));
		expect(run).toHaveBeenCalledOnce();
	});

	it('returns transient push failures for bounded alarm retries', async () => {
		vi.mocked(deserializeVapidKeys).mockResolvedValue({} as never);
		vi.mocked(sendPushNotificationWithoutContact).mockResolvedValue(new Response('busy', { status: 503 }));
		const prepare = vi.fn((sql: string) => {
			const statement = {
				bind: vi.fn(() => statement),
				run: vi.fn(async () => ({})),
				all: vi.fn(async () => ({
					results: sql.includes('FROM push_subscriptions')
						? [{ id: 'retry-subscription', endpoint: 'https://push.example/retry', p256dh: 'key', auth: 'auth' }]
						: [{ public_key: 'public', private_key: 'private' }],
				})),
			};
			return statement;
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await sendToAllSubscriptions({ prepare } as unknown as D1Database, { title: 'Test', body: '' });

		expect(result).toMatchObject({ failed: 1, quarantined: 0, failedSubscriptionIds: ['retry-subscription'] });
	});
});
