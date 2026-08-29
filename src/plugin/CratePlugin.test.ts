import { describe, expect, it, vi } from 'vitest';
import CratePlugin from './CratePlugin';
import { normalizeCrateSettings } from './settings';

vi.mock('../reminders/plugin-integration', () => ({ reinitializeReminders: vi.fn() }));
vi.mock('../reminders/settings', () => ({
	useRemindersSettingsStore: { getState: () => ({}) },
}));
vi.mock('../reminders/settings-storage', () => ({
	loadRemindersSettings: vi.fn(),
	writeRemindersSettings: vi.fn(),
}));
vi.mock('../reminders/ui/workspaceLayout', () => ({
	activateOrRevealRemindersLeaf: vi.fn(),
}));
vi.mock('./lifecycle', () => ({
	bootstrapPlugin: vi.fn(),
	shutdownPlugin: vi.fn(),
}));

describe('CratePlugin settings persistence', () => {
	it('preserves the shared settings object across deployment and connection saves', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async () => {});
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings,
		});

		plugin.settings.cloudflareDeployment = {
			deploymentId: '0123456789abcdef',
			accountId: '0123456789abcdef0123456789abcdef',
			accountName: 'Example account',
			workerName: 'crate-0123456789abcdef',
			d1DatabaseName: 'crate-0123456789abcdef',
			d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
			r2BucketName: 'crate-0123456789abcdef',
			workersSubdomain: 'example-account',
			lastDeployedVersion: '0.1.0',
			lastDeployedFingerprint: 'f'.repeat(64),
		};
		await plugin.saveSettings();

		expect(plugin.settings).toBe(settings);

		settings.workerUrl = 'https://crate.example.workers.dev';
		await plugin.saveSettings();

		expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({
			workerUrl: 'https://crate.example.workers.dev',
		}));
	});

	it('applies proposed settings only after persistence succeeds', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const saveData = vi.fn(async () => {});
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData,
			settings,
		});

		await plugin.writeSettings({ syncInterval: 120 });

		expect(plugin.settings).toBe(settings);
		expect(plugin.settings.syncInterval).toBe(120);
		expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ syncInterval: 120 }));
	});

	it('keeps runtime settings unchanged when a proposed write fails', async () => {
		const plugin = new CratePlugin({} as never, {} as never);
		const settings = normalizeCrateSettings({}, 'vault-config');
		Object.assign(plugin, {
			app: { vault: { configDir: 'vault-config' } },
			saveData: vi.fn().mockRejectedValue(new Error('disk full')),
			settings,
		});

		await expect(plugin.writeSettings({ syncInterval: 120 })).rejects.toThrow('disk full');

		expect(plugin.settings).toBe(settings);
		expect(plugin.settings.syncInterval).toBe(300);
	});
});
