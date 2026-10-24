import { describe, expect, it } from 'vitest';
import { addReminderIdentityOwners, releaseReminderIdentityOwners, type ReminderIdentityOwners } from './reminder-identity-owners';

const owner = (id: string, filePath: string, line = 0) => ({ id, filePath, line });

describe('releaseReminderIdentityOwners', () => {
	it('drops every copy of a released owner from the entries and the owner map', () => {
		const owners: ReminderIdentityOwners = new Map();
		const entries = [owner('x', 'A.md', 1), owner('y', 'A.md'), owner('x', 'A.md', 2), owner('x', 'B.md')];
		addReminderIdentityOwners(owners, entries);
		const kept = releaseReminderIdentityOwners(owners, entries, [{ id: 'x', filePath: 'A.md' }]);
		expect(kept).toEqual([owner('y', 'A.md'), owner('x', 'B.md')]);
		expect([...owners.get('x')!]).toEqual(['B.md']);
		expect([...owners.get('y')!]).toEqual(['A.md']);
	});

	it('releases a known owner that has no indexed entry yet', () => {
		const owners: ReminderIdentityOwners = new Map([['x', new Set(['A.md', 'B.md'])]]);
		expect(releaseReminderIdentityOwners(owners, [], [{ id: 'x', filePath: 'A.md' }])).toEqual([]);
		expect([...owners.get('x')!]).toEqual(['B.md']);
	});

	it('replaces every entry of a rescanned file and works without an owner map', () => {
		const owners: ReminderIdentityOwners = new Map();
		const entries = [owner('x', 'A.md'), owner('y', 'B.md'), owner('z', 'C.md')];
		addReminderIdentityOwners(owners, entries);
		expect(releaseReminderIdentityOwners(owners, entries, [{ id: 'z', filePath: 'C.md' }], 'A.md')).toEqual([owner('y', 'B.md')]);
		expect(owners.get('x')!.size).toBe(0);
		expect(owners.get('z')!.size).toBe(0);
		expect(releaseReminderIdentityOwners(undefined, entries, [], 'B.md')).toEqual([owner('x', 'A.md'), owner('z', 'C.md')]);
	});
});
