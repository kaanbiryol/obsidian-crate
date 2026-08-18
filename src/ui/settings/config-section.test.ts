import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_KEYS } from '../../plugin/types';

const noticeMessages: string[] = [];
const generateSecureToken = vi.fn();
const hashToken = vi.fn();
const authorizeDeviceEnrollment = vi.fn();
const syncApiClientCtor = vi.fn();

async function loadConfigLinkModule() {
	vi.doMock('obsidian', () => ({
		Notice: class Notice {
			constructor(message?: string) {
				if (message) noticeMessages.push(message);
			}
		},
	}));
	vi.doMock('../../sync/api', () => ({ SyncApiClient: syncApiClientCtor }));
	vi.doMock('../../sync/device-token', () => ({ generateSecureToken, hashToken }));

	return import('./config-link');
}

beforeEach(() => {
	noticeMessages.length = 0;
	generateSecureToken.mockReset();
	hashToken.mockReset();
	authorizeDeviceEnrollment.mockReset();
	syncApiClientCtor.mockReset();
	syncApiClientCtor.mockImplementation(function () {
		return { authorizeDeviceEnrollment };
	});
});

afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../sync/api');
	vi.doUnmock('../../sync/device-token');
});

describe('buildSetupLink', () => {
	it('returns null and shows a notice when the current auth token is missing', async () => {
		const { buildSetupLink } = await loadConfigLinkModule();
		const link = await buildSetupLink({
			secretStorage: { get: vi.fn(() => '') },
		} as never);

		expect(link).toBeNull();
		expect(noticeMessages).toEqual(['Auth token not found']);
	});

	it('creates a short-lived enrollment link without permanent credentials', async () => {
		const { buildSetupLink } = await loadConfigLinkModule();
		generateSecureToken.mockReturnValue('one-time-enrollment-token');
		hashToken.mockResolvedValue('hashed-enrollment-token');
		authorizeDeviceEnrollment.mockResolvedValue({ expiresAt: '2026-08-18T12:10:00.000Z' });

		const link = await buildSetupLink({
			secretStorage: {
				get: vi.fn((key: string) => key === SECRET_KEYS.AUTH_TOKEN ? 'current-auth-token' : ''),
			},
			settings: { workerUrl: 'https://worker.example/' },
		} as never);

		expect(hashToken).toHaveBeenCalledWith('one-time-enrollment-token');
		expect(syncApiClientCtor).toHaveBeenCalledWith('https://worker.example', 'current-auth-token');
		expect(authorizeDeviceEnrollment).toHaveBeenCalledWith('hashed-enrollment-token');
		const params = new URLSearchParams(link?.split('?')[1]);
		expect(params.get('workerUrl')).toBe('https://worker.example');
		expect(params.get('enrollmentToken')).toBe('one-time-enrollment-token');
		expect(params.get('expiresAt')).toBe('2026-08-18T12:10:00.000Z');
		expect(params.has('authToken')).toBe(false);
	});

	it('returns null when a new-device enrollment cannot be authorized', async () => {
		const { buildSetupLink } = await loadConfigLinkModule();
		generateSecureToken.mockReturnValue('one-time-enrollment-token');
		hashToken.mockResolvedValue('hashed-enrollment-token');
		authorizeDeviceEnrollment.mockRejectedValue(new Error('request failed'));

		const link = await buildSetupLink({
			secretStorage: {
				get: vi.fn((key: string) => key === SECRET_KEYS.AUTH_TOKEN ? 'current-auth-token' : ''),
			},
			settings: { workerUrl: 'https://worker.example' },
		} as never);

		expect(link).toBeNull();
		expect(noticeMessages).toEqual(['Failed to create a setup link for the new device']);
	});
});
