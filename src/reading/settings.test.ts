import { expect, it } from 'vitest';
import { normalizeReadingSettings } from './settings';

it.each([true, false])('keeps Reading enabled: %s when its saved folder is invalid', enabled => {
	expect(normalizeReadingSettings({ enabled, folderPath: '.hidden', confirmed: true })).toEqual({ enabled, confirmed: true, folderPath: 'Reading' });
});
