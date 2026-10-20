import { expect, it } from 'vitest';
import { parseReadingPolicy } from './reading-policy';

it('reads a complete Reading policy without carrying extra fields', () => {
	const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };
	expect(parseReadingPolicy({ ...policy, extra: true })).toEqual(policy);
});

it.each([null, [], { enabled: true, folder_path: 'Reading', generation: 'g', revision: 'r' },
	{ enabled: 1, folder_path: 'Reading', revision: 'r' }, { enabled: 1, folder_path: 'Reading', generation: 'g', revision: null }])('rejects %j', value => {
	expect(parseReadingPolicy(value)).toBeNull();
});
