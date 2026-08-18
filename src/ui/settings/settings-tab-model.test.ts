import { describe, expect, it } from 'vitest';
import { getSettingsTabSections } from './settings-tab-model';

describe('getSettingsTabSections', () => {
	it('shows server-backed sections only when sync is configured', () => {
		expect(getSettingsTabSections({ isConfigured: true })).toEqual({
			showSync: true,
			showNotifications: true,
			showInfrastructure: true,
		});
		expect(getSettingsTabSections({ isConfigured: false })).toEqual({
			showSync: false,
			showNotifications: false,
			showInfrastructure: false,
		});
	});
});
