import { describe, expect, it } from 'vitest';
import { getSettingsTabSections } from './settings-tab-model';

describe('getSettingsTabSections', () => {
	it('keeps server repair accessible after a reset disconnects this device', () => {
		expect(getSettingsTabSections({ isConfigured: false, hasDeployment: true })).toEqual({
			showReminders: false, showSync: false, showNotifications: false, showInfrastructure: true,
		});
	});

	it('shows server-backed sections only when sync is configured', () => {
		expect(getSettingsTabSections({ isConfigured: true })).toEqual({
			showReminders: true,
			showSync: true,
			showNotifications: true,
			showInfrastructure: true,
		});
		expect(getSettingsTabSections({ isConfigured: false })).toEqual({
			showReminders: false,
			showSync: false,
			showNotifications: false,
			showInfrastructure: false,
		});
	});
});
