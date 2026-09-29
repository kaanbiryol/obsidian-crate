import { expect, it, vi } from 'vitest';
import { admitLocally, authenticatedAdmissionKey, rememberAuthenticatedRequest } from './admission-state';

it('bounds a sync budget separately and expires both admission hints and budgets', async () => {
	vi.useFakeTimers();
	try {
		const db = {} as D1Database;
		const request = new Request('https://test/sync/manifest', { headers: { Authorization: 'Bearer owner' } });
		expect(await authenticatedAdmissionKey(request, db)).toBeUndefined();
		await rememberAuthenticatedRequest(request, db, true);
		expect(await authenticatedAdmissionKey(request, db)).toBeTruthy();
		for (let index = 0; index < 6_000; index++) expect(admitLocally(db, 'owner', 6_000)).toBe(true);
		expect(admitLocally(db, 'owner', 6_000)).toBe(false);
		expect(admitLocally(db, 'another-sender', 60)).toBe(true);
		vi.advanceTimersByTime(60_001);
		expect(await authenticatedAdmissionKey(request, db)).toBeUndefined();
		expect(admitLocally(db, 'owner', 6_000)).toBe(true);
	} finally { vi.useRealTimers(); }
});

it('bounds sender cardinality without resetting earlier counters', () => {
	const db = {} as D1Database;
	for (let index = 0; index < 512; index++) expect(admitLocally(db, `sender-${index}`, 1)).toBe(true);
	for (let index = 0; index < 60; index++) expect(admitLocally(db, `overflow-${index}`, 6_000)).toBe(true);
	expect(admitLocally(db, 'another-overflow', 6_000)).toBe(false);
	expect(admitLocally(db, 'sender-0', 1)).toBe(false);
});
