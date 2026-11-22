import { describe, expect, it } from 'vitest';
import { readRawManifest } from './manifest-read';

const entry = (hash: string) => ({ hash: hash.repeat(64), size: 5, modified: '2026-09-09 12:00:00', revision: `rev-${hash}` });
const page = (files: Record<string, ReturnType<typeof entry>>, extra: Record<string, unknown> = {}) =>
	({ version: 1, files, lastSeq: 3, snapshotSeq: 3, hasMore: false, ...extra });
const noChanges = { changes: [], lastSeq: 3, hasMore: false };

/** Answers each request path in order from `responses`, keyed by its route. */
function server(responses: { manifest: unknown[]; changes: unknown[] }) {
	const requested: string[] = [];
	return {
		requested,
		http: {
			requestJson: async <T>(path: string): Promise<T> => {
				requested.push(path);
				const queue = path.startsWith('/sync/manifest') ? responses.manifest : responses.changes;
				const next = queue.shift();
				if (next === undefined) throw new Error(`Unexpected request ${path}`);
				return next as T;
			},
		} as never,
	};
}

describe('readRawManifest', () => {
	it('reads every page at the first page’s snapshot, then replays the changelog since it', async () => {
		const h = server({
			manifest: [page({ 'a.md': entry('a') }, { hasMore: true, nextCursor: 'a.md' }), page({ 'b.md': entry('b') })],
			changes: [{ changes: [
				{ seq: 4, path: 'a.md', action: 'delete', hash: '', size: 0, created_at: '2026-09-09 12:01:00', revision: 'rev-del' },
				{ seq: 5, path: 'c.md', action: 'put', hash: 'c'.repeat(64), size: 7, created_at: '2026-09-09 12:02:00', revision: 'rev-c' },
			], lastSeq: 5, hasMore: false }],
		});
		const { files, lastSeq } = await readRawManifest(h.http);
		expect(Object.keys(files).sort()).toEqual(['b.md', 'c.md']);
		expect(files['c.md']).toEqual({ hash: 'c'.repeat(64), size: 7, modified: '2026-09-09 12:02:00', revision: 'rev-c' });
		expect(lastSeq).toBe(5);
		expect(h.requested).toEqual(['/sync/manifest?limit=2000', '/sync/manifest?limit=2000&after=a.md&snapshotSeq=3', '/sync/changes?since=3']);
	});

	it.each([
		['the snapshot changes between pages', [page({ 'a.md': entry('a') }, { hasMore: true, nextCursor: 'a.md' }), page({ 'b.md': entry('b') }, { lastSeq: 4, snapshotSeq: 4 })], [], 'snapshot changed during pagination'],
		['a page repeats a file', [page({ 'a.md': entry('a') }, { hasMore: true, nextCursor: 'a.md' }), page({ 'a.md': entry('a') })], [], 'repeated a file during pagination'],
		['the changelog expired', [page({ 'a.md': entry('a') })], [{ ...noChanges, cursorExpired: true }], 'changed too quickly to load safely'],
	])('fails instead of returning a partial manifest when %s', async (_name, manifest, changes, error) => {
		await expect(readRawManifest(server({ manifest, changes }).http)).rejects.toThrow(error);
	});
});
