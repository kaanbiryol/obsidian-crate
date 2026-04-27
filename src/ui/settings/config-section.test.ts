import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_KEYS } from '../../plugin/types';

const noticeMessages: string[] = [];
const requestUrl = vi.fn();
const buildCloudflareTokenTemplateUrl = vi.fn();
const generateAuthToken = vi.fn();
const listAccessibleAccounts = vi.fn();
const verifyToken = vi.fn();
const computeTokenHash = vi.fn();
const quickSetup = vi.fn();
const applySharedSettings = vi.fn();
const getSharedSettings = vi.fn();
const syncApiClientCtor = vi.fn();

async function loadConfigSectionModule() {
	vi.doMock('obsidian', () => ({
		Notice: class Notice {
			constructor(message?: string) {
				if (message) {
					noticeMessages.push(message);
				}
			}
		},
		Platform: {
			isIosApp: false,
			isAndroidApp: false,
			isMacOS: true,
			isMobileApp: false,
			isWin: false,
			isLinux: false,
			isDesktopApp: true,
		},
		requestUrl,
		Setting: class Setting {},
	}));
	vi.doMock('../../cloudflare/api', () => ({
		buildCloudflareTokenTemplateUrl,
		generateAuthToken,
		listAccessibleAccounts,
		verifyToken,
	}));
	vi.doMock('../../cloudflare/infrastructure', () => ({
		computeTokenHash,
		quickSetup,
	}));
	vi.doMock('../../sync/api', () => ({
		SyncApiClient: syncApiClientCtor,
	}));
	vi.doMock('../../sync/shared-settings', () => ({
		applySharedSettings,
	}));
	vi.doMock('../confirmation-modal', () => ({
		openConfirmationModal: vi.fn(),
	}));
	vi.doMock('../qr-modal', () => ({
		QRModal: class QRModal {},
	}));
	vi.doMock('./action-helpers', () => ({
		getErrorMessage: vi.fn((error: unknown) => String(error)),
		runButtonTask: vi.fn(),
	}));
	vi.doMock('./section-helpers', () => ({
		createSettingsSectionHeading: vi.fn(),
	}));

	return import('./config-section');
}

beforeEach(() => {
	noticeMessages.length = 0;
	requestUrl.mockReset();
	buildCloudflareTokenTemplateUrl.mockReset();
	generateAuthToken.mockReset();
	listAccessibleAccounts.mockReset();
	verifyToken.mockReset();
	computeTokenHash.mockReset();
	quickSetup.mockReset();
	applySharedSettings.mockReset();
	getSharedSettings.mockReset();
	syncApiClientCtor.mockReset();
	syncApiClientCtor.mockImplementation(() => ({
		getSharedSettings,
	}));
});

afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/api');
	vi.doUnmock('../../cloudflare/infrastructure');
	vi.doUnmock('../../sync/api');
	vi.doUnmock('../../sync/shared-settings');
	vi.doUnmock('../confirmation-modal');
	vi.doUnmock('../qr-modal');
	vi.doUnmock('./action-helpers');
	vi.doUnmock('./section-helpers');
});

describe('resolveCredentialsForSetup', () => {
	it('persists validated wizard credentials before setup', async () => {
		const { resolveCredentialsForSetup } = await loadConfigSectionModule();
		const saveCredentials = vi.fn(async () => {});
		const resolveCredentials = vi.fn();

		const credentials = await resolveCredentialsForSetup({
			cloudflareSession: {
				saveCredentials,
				resolveCredentials,
			},
		} as never, {
			wizardToken: ' token-abc ',
			wizardTokenValidated: true,
			wizardSelectedAccountId: ' acct-123 ',
		});

		expect(credentials).toEqual({
			accountId: 'acct-123',
			apiToken: 'token-abc',
		});
		expect(saveCredentials).toHaveBeenCalledWith('acct-123', 'token-abc');
		expect(resolveCredentials).not.toHaveBeenCalled();
	});

	it('falls back to stored Cloudflare session credentials when the wizard is incomplete', async () => {
		const { resolveCredentialsForSetup } = await loadConfigSectionModule();
		const resolveCredentials = vi.fn(async () => ({
			accountId: 'acct-stored',
			apiToken: 'stored-token',
		}));

		const credentials = await resolveCredentialsForSetup({
			cloudflareSession: {
				saveCredentials: vi.fn(),
				resolveCredentials,
			},
		} as never, {
			wizardToken: '',
			wizardTokenValidated: false,
			wizardSelectedAccountId: '',
		});

		expect(credentials).toEqual({
			accountId: 'acct-stored',
			apiToken: 'stored-token',
		});
		expect(resolveCredentials).toHaveBeenCalledTimes(1);
	});
});

describe('createInfrastructureFromCredentials', () => {
	it('wires quick setup results into sync runtime configuration and shared settings', async () => {
		const { createInfrastructureFromCredentials } = await loadConfigSectionModule();
		const sharedSettings = {
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 300,
			showStatusBar: true,
			pushEnabled: true,
		};
		const applyInfrastructureConfig = vi.fn(async () => {});
		const pushSharedSettings = vi.fn(async () => {});
		const onProgress = vi.fn();
		const pluginSettings = {
			deviceId: '',
			ignorePatterns: [],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 0,
			showStatusBar: false,
			pushEnabled: false,
		};

		quickSetup.mockResolvedValue({
			workerUrl: 'https://worker.example',
			authToken: 'worker-auth-token',
			workerName: 'crate-worker',
			bucketName: 'crate-bucket',
			databaseId: 'db-123',
		});
		getSharedSettings.mockResolvedValue({ settings: sharedSettings });

		await createInfrastructureFromCredentials({
			settings: pluginSettings,
			clearSettingsUiState: vi.fn(),
			syncRuntime: {
				applyInfrastructureConfig,
				pushSharedSettings,
			},
		} as never, {
			accountId: 'acct-123',
			apiToken: 'cloudflare-api-token',
		}, onProgress);

		expect(quickSetup).toHaveBeenCalledWith({
			accountId: 'acct-123',
			apiToken: 'cloudflare-api-token',
			deviceId: '',
			deviceName: 'Mac (this)',
			platform: 'macos',
		}, onProgress);
		expect(syncApiClientCtor).toHaveBeenCalledWith('https://worker.example', 'worker-auth-token');
		expect(applySharedSettings).toHaveBeenCalledWith(pluginSettings, sharedSettings);
		expect(applyInfrastructureConfig).toHaveBeenCalledWith({
			workerUrl: 'https://worker.example',
			authToken: 'worker-auth-token',
			workerName: 'crate-worker',
			bucketName: 'crate-bucket',
			databaseId: 'db-123',
			accountId: 'acct-123',
		});
		expect(pushSharedSettings).toHaveBeenCalledTimes(1);
	});
});

describe('buildSetupLink', () => {
	it('returns null and shows a notice when the current auth token is missing', async () => {
		const { buildSetupLink } = await loadConfigSectionModule();

		const link = await buildSetupLink({
			secretStorage: {
				get: vi.fn(() => ''),
			},
		} as never);

		expect(link).toBeNull();
		expect(noticeMessages).toEqual(['Auth token not found']);
	});

	it('registers a fresh setup token and includes infrastructure metadata in the setup link', async () => {
		const { buildSetupLink } = await loadConfigSectionModule();

		generateAuthToken.mockReturnValue('new-device-token');
		computeTokenHash.mockResolvedValue('hashed-token');
		requestUrl.mockResolvedValue({ status: 200 });

		const link = await buildSetupLink({
			secretStorage: {
				get: vi.fn((key: string) => key === SECRET_KEYS.AUTH_TOKEN ? 'current-auth-token' : ''),
			},
			settings: {
				workerUrl: 'https://worker.example',
				workerName: 'crate-worker',
				bucketName: 'crate-bucket',
				databaseId: 'db-123',
				cloudflareAccountId: 'acct-123',
			},
		} as never);

		expect(computeTokenHash).toHaveBeenCalledWith('new-device-token');
		expect(requestUrl).toHaveBeenCalledWith({
			url: 'https://worker.example/auth/tokens',
			method: 'POST',
			headers: {
				Authorization: 'Bearer current-auth-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ token_hash: 'hashed-token', device_name: 'setup-link' }),
		});
		expect(link).toBeTruthy();

		const params = new URLSearchParams(link?.split('?')[1]);
		expect(params.get('workerUrl')).toBe('https://worker.example');
		expect(params.get('authToken')).toBe('new-device-token');
		expect(params.get('workerName')).toBe('crate-worker');
		expect(params.get('bucketName')).toBe('crate-bucket');
		expect(params.get('databaseId')).toBe('db-123');
		expect(params.get('accountId')).toBe('acct-123');
	});

	it('returns null when the new device token cannot be registered', async () => {
		const { buildSetupLink } = await loadConfigSectionModule();

		generateAuthToken.mockReturnValue('new-device-token');
		computeTokenHash.mockResolvedValue('hashed-token');
		requestUrl.mockRejectedValue(new Error('request failed'));

		const link = await buildSetupLink({
			secretStorage: {
				get: vi.fn((key: string) => key === SECRET_KEYS.AUTH_TOKEN ? 'current-auth-token' : ''),
			},
			settings: {
				workerUrl: 'https://worker.example',
				workerName: '',
				bucketName: '',
				databaseId: '',
				cloudflareAccountId: '',
			},
		} as never);

		expect(link).toBeNull();
		expect(noticeMessages).toEqual(['Failed to register token for new device']);
	});
});
