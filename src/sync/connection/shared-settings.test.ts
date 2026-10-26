import { expect, it } from 'vitest';
import { rebaseSharedSettings } from './shared-settings';

it('rebases only the settings this device changed onto the server\'s', () => {
	const base = { ignorePatterns: ['*.tmp'], syncInterval: 300, pushEnabled: false };
	const remote = { ignorePatterns: ['Archive/'], syncInterval: 300, pushEnabled: true };
	expect(rebaseSharedSettings(base, { ...base, syncInterval: 60 }, remote)).toEqual({ ...remote, syncInterval: 60 });
	expect(rebaseSharedSettings(base, { ...base, pushEnabled: true }, remote)).toEqual(remote);
	expect(rebaseSharedSettings(base, { ...base, ignorePatterns: ['Inbox/'] }, remote)).toBeNull();
});
