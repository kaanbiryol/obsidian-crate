import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiagnosticsSettingsStateKey } from '../../plugin/settings-ui-state';
import {
	FakeElement,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

async function loadInfrastructureManagementSectionModule() {
	vi.doMock('../../cloudflare/plugin-integration', () => ({ startCloudflareDeployment: vi.fn() }));
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../confirmation-modal', () => ({
		openConfirmationModal: vi.fn(),
	}));
	vi.doMock('./section-helpers', () => ({
		createSettingsSubsectionHeading: vi.fn(),
	}));

	return import('./infrastructure-management-section');
}

describe('renderInfrastructureManagementSection', () => {
	beforeEach(() => {
		resetObsidianUiMocks();
	});

	afterEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.doUnmock('../../cloudflare/plugin-integration');
		vi.doUnmock('obsidian');
		vi.doUnmock('../confirmation-modal');
		vi.doUnmock('./section-helpers');
	});

	it('re-renders cached diagnostics when the settings tab is reopened', async () => {
		const { renderInfrastructureManagementSection } = await loadInfrastructureManagementSectionModule();
		const containerEl = new FakeElement('div');
		const settings = {
			workerUrl: 'https://crate-worker.example.workers.dev',
		};

		renderInfrastructureManagementSection({
			containerEl: containerEl as never,
			plugin: {
				settings,
				settingsUiState: {
					diagnostics: {
						key: buildDiagnosticsSettingsStateKey(settings),
						results: [
							{
								name: 'Cloudflare credentials',
								status: 'pass',
								message: 'Credentials verified.',
							},
						],
					},
				},
				syncRuntime: {
					getApiClient: vi.fn(),
				},
			} as never,
			isConfigured: true,
			rerender: vi.fn(),
		});

		expect(containerEl.collectText()).toContain('PASS Cloudflare credentials: Credentials verified.');
	});
});
