import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';

const rendered: string[] = [];
const section = (name: string) => vi.fn(() => { rendered.push(name); });

afterEach(() => {
	rendered.length = 0;
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
});

async function display(isConfigured: boolean): Promise<string[]> {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), PluginSettingTab: class {
		readonly containerEl = new FakeElement('div');
		constructor(public readonly app: unknown, public readonly plugin: unknown) {}
		update(this: { display(): void }): void { this.display(); }
	} }));
	vi.doMock('./settings/appearance-section', () => ({ renderAppearanceSettings: section('appearance') }));
	vi.doMock('./plugin/settings-disclosure', () => ({ createSettingsDisclosure: vi.fn() }));
	vi.doMock('./settings/infrastructure/usage-section', () => ({ renderUsageSection: section('usage') }));
	vi.doMock('./settings/infrastructure/connection-status', () => ({ renderConnectionStatus: section('connection') }));
	vi.doMock('./settings/infrastructure/server-selection-setting', () => ({ renderForgetServerSetting: section('forget server') }));
	vi.doMock('./settings/infrastructure/config-section', () => ({
		renderConfigSection: section('config'), renderServerSection: section('server'), renderServerUpdateNotice: section('update notice'),
	}));
	vi.doMock('./settings/devices-section', () => ({ renderDevicesSection: section('devices') }));
	vi.doMock('./settings/infrastructure/infrastructure-section', () => ({ renderInfrastructureSection: section('infrastructure'), renderServerActions: section('server actions') }));
	vi.doMock('./settings/sync-section', () => ({ renderSyncSection: section('sync') }));
	vi.doMock('../reminders/ui/plugin/settings-section', () => ({ renderRemindersSettings: section('reminders') }));
	vi.doMock('./settings/notifications-section', () => ({ renderNotificationsSection: section('notifications') }));
	vi.doMock('./settings/reminders-web-app', () => ({ renderCrateWebApp: section('web app') }));
	vi.doMock('../reading/ui/plugin/settings-section', () => ({ renderReadingSettings: section('reading') }));
	vi.doMock('./settings/settings-view-state', () => ({ captureSettingsView: vi.fn(), restoreSettingsView: vi.fn() }));
	vi.doMock('../plugin/shared-settings-sync', () => ({ sharedSettingsSync: () => ({ observe: vi.fn(), push: vi.fn() }) }));
	const { CrateSettingTab } = await import('./settings-tab');
	const plugin = { manifest: { version: '1.0.0' }, settings: { cloudflareDeployment: null }, syncRuntime: { isConfigured: () => isConfigured } };
	new CrateSettingTab({} as never, plugin as never).update();
	return rendered;
}

it('shows reminders and Reading controls before a server is connected', async () => {
	const sections = await display(false);
	expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toContain('Features');
	expect(sections).toEqual(expect.arrayContaining(['config', 'reminders', 'reading']));
	expect(sections).not.toContain('notifications');
});

it('keeps notifications with the feature controls once connected', async () => {
	const sections = await display(true);
	const features = sections.indexOf('reminders');
	expect(sections.slice(features, features + 3)).toEqual(['reminders', 'reading', 'notifications']);
});
