import { expect, it } from 'vitest';
import { normalizeSharedSettingsValue } from './shared-settings';

it('rejects shared settings missing required flags', () => {
	expect(normalizeSharedSettingsValue({
		ignorePatterns: ['.git/'],
		syncOnStartup: true,
		syncInterval: 30,
	})).toBeNull();
});
