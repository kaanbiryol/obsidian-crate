import { describe, expect, it } from 'vitest';
import type { SharedSettings } from '../plugin/types';
import { applySharedSettings, normalizeSharedSettingsValue } from './shared-settings';

describe('shared-settings helpers', () => {
	it('normalizes stored shared settings and defaults missing pushEnabled to false', () => {
		expect(normalizeSharedSettingsValue({
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncInterval: 30,
			showStatusBar: true,
		})).toEqual({
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncInterval: 30,
			showStatusBar: true,
			pushEnabled: false,
		} satisfies SharedSettings);
	});

	it('applies all shared settings to local plugin settings', () => {
		const target = {
			ignorePatterns: ['.trash/'],
			syncOnStartup: false,
			syncInterval: 10,
			showStatusBar: false,
			pushEnabled: false,
		};

		applySharedSettings(target, {
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncInterval: 300,
			showStatusBar: true,
			pushEnabled: true,
		});

		expect(target).toEqual({
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncInterval: 300,
			showStatusBar: true,
			pushEnabled: true,
		});
	});
});
