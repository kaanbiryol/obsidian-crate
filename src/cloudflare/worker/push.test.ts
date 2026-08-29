import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVapidKeys, serializeVapidKeys } from 'web-push-browser';
import { createDeclarativePushPayload, getOrCreateVapidKeys } from './push';

vi.mock('web-push-browser', async (importOriginal) => {
	const original = await importOriginal<typeof import('web-push-browser')>();
	return {
		...original,
		generateVapidKeys: vi.fn(),
		serializeVapidKeys: vi.fn(),
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
