import { describe, expect, it } from 'vitest';
import { applySharedSettings } from './shared-settings';

describe('shared-settings helpers', () => {
	it('applies shared settings without changing local status bar visibility', () => {
		const target = {
			ignorePatterns: ['.trash/'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 10,
			pushEnabled: false,
		};

		applySharedSettings(target, {
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 300,
			pushEnabled: true,
		});

		expect(target).toEqual({
			ignorePatterns: ['.git/'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 300,
			pushEnabled: true,
		});
	});
});
