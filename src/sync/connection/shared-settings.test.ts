import { describe, expect, it } from 'vitest';
import { applySharedSettings, buildSharedSettings } from './shared-settings';

describe('shared-settings helpers', () => {
	it('applies shared settings without changing local status bar visibility', () => {
		const target = {
			ignorePatterns: ['.trash/'],
			syncInterval: 10,
			pushEnabled: false,
		};

		applySharedSettings(target, {
			ignorePatterns: ['.git/'],
			syncInterval: 300,
			pushEnabled: true,
		});

		expect(target).toEqual({
			ignorePatterns: ['.git/'],
			syncInterval: 300,
			pushEnabled: true,
		});
	});
});

it('round-trips every replicated field', () => {
	const source = { ignorePatterns: ['Archive/', '*.tmp'], syncInterval: 120, pushEnabled: true };
	const target = { ignorePatterns: [], syncInterval: 300, pushEnabled: false };
	applySharedSettings(target, buildSharedSettings(source));
	expect(target).toEqual(source);
	expect(target.ignorePatterns).not.toBe(source.ignorePatterns);
});
