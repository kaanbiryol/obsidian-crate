import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDiagnosticsSettingsStateKey } from '../../plugin/settings-ui-state';
import {
	FakeElement,
	MockButtonComponent,
	MockSetting,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

class MockTextComponent {
	readonly inputEl = {
		type: 'text',
		size: 0,
	};

	setValue(_value: string): this {
		return this;
	}

	setDisabled(_disabled: boolean): this {
		return this;
	}

	onChange(_callback: (value: string) => unknown): this {
		return this;
	}

	setPlaceholder(_placeholder: string): this {
		return this;
	}
}

class MockSettingWithText extends MockSetting {
	addText(callback: (text: MockTextComponent) => unknown): this {
		callback(new MockTextComponent());
		return this;
	}
}

function createObsidianUiModuleWithText(): Record<string, unknown> {
	return {
		Setting: MockSettingWithText,
		ButtonComponent: MockButtonComponent,
		ExtraButtonComponent: MockButtonComponent,
		Notice: class Notice {},
	};
}

async function loadInfrastructureManagementSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModuleWithText());
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
		vi.doUnmock('obsidian');
		vi.doUnmock('../confirmation-modal');
		vi.doUnmock('./section-helpers');
	});

	it('re-renders cached diagnostics when the settings tab is reopened', async () => {
		const { renderInfrastructureManagementSection } = await loadInfrastructureManagementSectionModule();
		const containerEl = new FakeElement('div');
		const settings = {
			cloudflareAccountId: 'acct-1',
			workerUrl: 'https://crate-worker.example.workers.dev',
			workerName: 'crate-worker',
			bucketName: 'crate-bucket',
			databaseId: 'db-1',
		};

		renderInfrastructureManagementSection({
			containerEl: containerEl as never,
			plugin: {
				settings,
				settingsUiState: {
					usage: null,
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
				cloudflareSession: {
					hasCredentials: () => false,
				},
			} as never,
			isConfigured: true,
			rerender: vi.fn(),
		});

		expect(containerEl.collectText()).toContain('PASS Cloudflare credentials: Credentials verified.');
	});
});
