import { describe, expect, it } from 'vitest';
import { isChangelogCursorExpired, parseChangelogSince } from './storage';

describe('changelog cursors', () => {
	const bounds = { lastSeq: 20, minSeq: 11, snapshotSeq: 5 };
	it('continues a cursor whose next row is retained', () => {
		expect(isChangelogCursorExpired(10, bounds)).toBe(false);
		expect(isChangelogCursorExpired(20, bounds)).toBe(false);
		expect(isChangelogCursorExpired(0, { lastSeq: 0, minSeq: null, snapshotSeq: 0 })).toBe(false);
	});
	it('expires a cursor behind pruned rows or before the import snapshot', () => {
		expect(isChangelogCursorExpired(9, bounds)).toBe(true);
		expect(isChangelogCursorExpired(4, bounds)).toBe(true);
		// An empty retained log can only continue the latest sequence.
		expect(isChangelogCursorExpired(7, { lastSeq: 9, minSeq: null, snapshotSeq: 0 })).toBe(true);
		expect(isChangelogCursorExpired(9, { lastSeq: 9, minSeq: null, snapshotSeq: 0 })).toBe(false);
	});
	it('reads since leniently and rejects negative or missing numbers', () => {
		const since = (query: string) => parseChangelogSince(new URL(`https://crate.test/sync/changes${query}`));
		expect(since('')).toBe(0);
		expect(since('?since=12')).toBe(12);
		expect(since('?since=12abc')).toBe(12);
		expect(since('?since=-1')).toBeNull();
		expect(since('?since=abc')).toBeNull();
	});
});
