import { describe, expect, it } from 'vitest';
import { applySharedSettings, normalizeSharedSettingsValue } from './shared-settings';

describe('shared-settings helpers', () => {
	it('rejects shared settings missing required flags', () => {
		expect(normalizeSharedSettingsValue({
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncInterval: 30,
			showStatusBar: true,
		})).toBeNull();
	});

	it('applies all shared settings to local plugin settings', () => {
		const target = {
			ignorePatterns: ['.trash/'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 10,
			showStatusBar: false,
			pushEnabled: false,
		};

		applySharedSettings(target, {
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 300,
			showStatusBar: true,
			pushEnabled: true,
		});

		expect(target).toEqual({
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 300,
			showStatusBar: true,
			pushEnabled: true,
		});
	});
});
