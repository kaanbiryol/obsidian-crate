import { describe, expect, it } from 'vitest';
import { getSettingsTabSections } from './settings-tab-model';

describe('getSettingsTabSections', () => {
	it('shows all advanced sections when sync is configured', () => {
		expect(getSettingsTabSections({
			isConfigured: true,
			hasCloudflareCredentials: false,
		})).toEqual({
			showSync: true,
			showNotifications: true,
			showUsage: true,
			showInfrastructure: true,
		});
	});

	it('shows infrastructure only when Cloudflare credentials exist without sync configuration', () => {
		expect(getSettingsTabSections({
			isConfigured: false,
			hasCloudflareCredentials: true,
		})).toEqual({
			showSync: false,
			showNotifications: false,
			showUsage: false,
			showInfrastructure: true,
		});
	});

	it('hides advanced sections when the plugin is not configured and no credentials are stored', () => {
		expect(getSettingsTabSections({
			isConfigured: false,
			hasCloudflareCredentials: false,
		})).toEqual({
			showSync: false,
			showNotifications: false,
			showUsage: false,
			showInfrastructure: false,
		});
	});
});
