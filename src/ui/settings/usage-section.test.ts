import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUsageSettingsStateKey } from '../../plugin/settings-ui-state';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadUsageSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('./section-helpers', () => ({
		createSettingsSectionHeading: vi.fn(),
	}));

	return import('./usage-section');
}

function getSettingByName(name: string): MockSetting {
	const setting = MockSetting.instances.find((instance) => instance.nameEl.textContent === name);
	if (!setting) {
		throw new Error(`Setting not found: ${name}`);
	}
	return setting;
}

describe('renderUsageSection', () => {
	beforeEach(() => {
		resetObsidianUiMocks();
	});

	afterEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.doUnmock('obsidian');
		vi.doUnmock('./section-helpers');
	});

	it('re-renders the last fetched usage snapshot when the settings tab is reopened', async () => {
		const { renderUsageSection } = await loadUsageSectionModule();
		const containerEl = new FakeElement('div');
		const settings = {
			cloudflareAccountId: 'acct-1',
			workerName: 'crate-worker',
			bucketName: 'crate-bucket',
			databaseId: 'db-1',
		};

		renderUsageSection({
			containerEl: containerEl as never,
			plugin: {
				settings,
				settingsUiState: {
					usage: {
						key: buildUsageSettingsStateKey(settings),
						data: {
							available: true,
							workers: {
								requests: { current: 204, limit: 100000, unit: 'requests' },
							},
							r2: {
								storageBytes: { current: 137 * 1024 * 1024, limit: 10 * 1024 * 1024 * 1024, unit: 'bytes' },
								classAOps: { current: 270, limit: 1000000, unit: 'requests' },
								classBOps: { current: 810, limit: 10000000, unit: 'requests' },
							},
							d1: {
								rowsRead: { current: 1221, limit: 5000000, unit: 'rows' },
								rowsWritten: { current: 26, limit: 100000, unit: 'rows' },
								storageBytes: { current: 3.6 * 1024 * 1024, limit: 5 * 1024 * 1024 * 1024, unit: 'bytes' },
							},
							queriedAt: '2026-04-19T21:19:20.000Z',
						},
					},
				},
			} as never,
		});

		expect(containerEl.collectText()).toContain('Workers (daily)');
		expect(containerEl.collectText()).toContain('204 / 100,000');
		expect(containerEl.collectText()).toContain('Last updated:');
	});

	it('stores the fetched usage snapshot so the next settings render can reuse it', async () => {
		const { renderUsageSection } = await loadUsageSectionModule();
		const containerEl = new FakeElement('div');
		const settings = {
			cloudflareAccountId: 'acct-1',
			workerName: 'crate-worker',
			bucketName: 'crate-bucket',
			databaseId: 'db-1',
		};
		const response = {
			available: true,
			workers: {
				requests: { current: 204, limit: 100000, unit: 'requests' },
			},
			r2: {
				storageBytes: { current: 137 * 1024 * 1024, limit: 10 * 1024 * 1024 * 1024, unit: 'bytes' },
				classAOps: { current: 270, limit: 1000000, unit: 'requests' },
				classBOps: { current: 810, limit: 10000000, unit: 'requests' },
			},
			queriedAt: '2026-04-19T21:19:20.000Z',
		};
		const plugin = {
			settings,
			settingsUiState: {
				usage: null,
			},
			secretStorage: {
				get: vi.fn(() => 'cloudflare-api-token'),
			},
			syncRuntime: {
				getApiClient: vi.fn(() => ({ client: 'sync-api' })),
			},
			usageService: {
				getUsage: vi.fn(async () => response),
			},
		};

		renderUsageSection({
			containerEl: containerEl as never,
			plugin: plugin as never,
		});

		getSettingByName('Refresh metrics').buttons[0]?.click();
		await flushMicrotasks();

		expect(plugin.usageService.getUsage).toHaveBeenCalledWith('cloudflare-api-token', { client: 'sync-api' });
		expect(plugin.settingsUiState.usage).toEqual({
			key: buildUsageSettingsStateKey(settings),
			data: response,
		});
		expect(containerEl.collectText()).toContain('Last updated:');
	});
});
