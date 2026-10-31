import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import type { ChangelogEntry } from '../../protocol/sync-types';
import { readIncrementalChangelog } from './incremental-changelog';

const change = fc.record({
	path: fc.constantFrom('note.md', 'a/b.md', '__proto__', 'Note.md'),
	action: fc.constantFrom('put' as const, 'delete' as const),
	hash: fc.constantFrom('h0', 'h1', 'h2'),
});
// Each page is a run of changes plus how many raw entries an encrypted page filtered out.
// The server always advances: a page with no visible entries filtered at least one.
const pages = fc.array(fc.record({ changes: fc.array(change, { maxLength: 5 }), filtered: fc.nat({ max: 3 }) })
	.map(page => page.changes.length ? page : { ...page, filtered: page.filtered + 1 }), { minLength: 1, maxLength: 6 });

it('keeps the newest entry per path, counts every entry and only moves the cursor forward', async () => {
	await fc.assert(fc.asyncProperty(fc.nat({ max: 100 }), pages, async (start, generated) => {
		let seq = start;
		const responses = generated.map(({ changes, filtered }, index) => {
			const entries = changes.map((item): ChangelogEntry => ({ ...item, seq: ++seq, size: 1, created_at: '2026-01-01T00:00:00.000Z' }));
			seq += filtered;
			const hasMore = index < generated.length - 1;
			// A page with filtered entries tells the client where the next one starts.
			return { changes: entries, lastSeq: start + 1000, hasMore, ...(filtered ? { nextSince: seq } : {}) };
		});
		const expectedEntries = responses.flatMap(response => response.changes);
		const queue = [...responses];
		const getChanges = vi.fn(async (_since: number) => queue.shift()!);
		const result = await readIncrementalChangelog({ getChanges }, start);

		const since = getChanges.mock.calls.map(([value]) => value);
		expect(since).toHaveLength(responses.length);
		expect(since[0]).toBe(start);
		for (let index = 1; index < since.length; index++) expect(since[index]).toBeGreaterThan(since[index - 1]!);
		const newest = new Map<string, ChangelogEntry>();
		for (const entry of expectedEntries) newest.set(entry.path, entry);
		expect(result).toEqual({ changesByPath: newest, changeCount: expectedEntries.length, latestSeq: start + 1000 });
	}), { numRuns: 200 });
});
