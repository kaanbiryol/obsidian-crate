import { describe, expect, it, vi } from 'vitest';
import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';
import { DeletedFileList, type DeletedFileSource } from './deleted-files';

let key = 0;
const version = (path: string, reason: RemoteFileVersion['reason'] = 'deleted', created_at = '2026-11-20 10:00:00'): RemoteFileVersion =>
	({ storage_key: `key-${++key}`, path, hash: 'a'.repeat(64), size: 1, reason, created_at, expires_at: 0 });

function source(pages: FileVersionsPage[], options: { remote?: string[]; local?: string[] } = {}) {
	const queue = [...pages];
	const listVersions = vi.fn(async (_query: FileVersionQuery) => queue.shift() ?? { versions: [], hasMore: false });
	const remotePaths = vi.fn(async (paths: string[]) => new Set(paths.filter(path => options.remote?.includes(path))));
	const localExists = vi.fn(async (path: string) => options.local?.includes(path) ?? false);
	return { listVersions, remotePaths, localExists } satisfies DeletedFileSource;
}
const paths = (rows: RemoteFileVersion[]) => rows.map(row => row.path);

describe('DeletedFileList', () => {
	it('keeps only deleted versions of files that are missing now', async () => {
		const src = source([{ versions: [version('gone.md'), version('edited.md', 'replaced'), version('back-local.md'), version('back-remote.md')], hasMore: false }],
			{ local: ['back-local.md'], remote: ['back-remote.md'] });
		const list = new DeletedFileList(src);
		expect(paths(await list.next())).toEqual(['gone.md']);
		expect(src.remotePaths).toHaveBeenCalledWith(['gone.md', 'back-local.md', 'back-remote.md']);
		expect(list.hasMore).toBe(false);
	});

	it('shows each path once with its latest deletion across pages', async () => {
		const latest = version('note.md', 'deleted', '2026-11-20 10:00:00');
		const src = source([
			{ versions: [latest, version('note.md', 'deleted', '2026-11-10 10:00:00')], hasMore: true, nextCursor: 'c1' },
			{ versions: [version('note.md', 'deleted', '2026-11-01 10:00:00'), version('other.md')], hasMore: false },
		]);
		const rows = await new DeletedFileList(src).next();
		expect(rows).toEqual([latest, expect.objectContaining({ path: 'other.md' })]);
		expect(src.remotePaths).toHaveBeenLastCalledWith(['other.md']);
	});

	it('does not show a recreated file once its newest deletion was hidden', async () => {
		const src = source([
			{ versions: [version('again.md')], hasMore: true, nextCursor: 'c1' },
			{ versions: [version('again.md')], hasMore: false },
		], { local: ['again.md'] });
		expect(await new DeletedFileList(src).next()).toEqual([]);
		expect(src.localExists).toHaveBeenCalledTimes(1);
	});

	it('pages with the server cursor and stops at a bounded number of pages per load', async () => {
		const pages: FileVersionsPage[] = Array.from({ length: 7 }, (_, index) => ({ versions: [version(`edit-${index}.md`, 'replaced')], hasMore: true, nextCursor: `c${index + 1}` }));
		const src = source(pages);
		const list = new DeletedFileList(src);
		expect(await list.next()).toEqual([]);
		expect(src.listVersions).toHaveBeenCalledTimes(5);
		expect(src.listVersions.mock.calls.map(([query]) => query.cursor)).toEqual([undefined, 'c1', 'c2', 'c3', 'c4']);
		expect(list.hasMore).toBe(true);
		await list.next();
		expect(src.listVersions.mock.calls.slice(5).map(([query]) => query.cursor)).toEqual(['c5', 'c6', 'c7']);
		expect(list.hasMore).toBe(false);
	});

	it('stops once a load has found enough rows and continues from that cursor', async () => {
		const many = Array.from({ length: 25 }, (_, index) => version(`file-${index}.md`));
		const src = source([{ versions: many, hasMore: true, nextCursor: 'next' }, { versions: [version('last.md')], hasMore: false }]);
		const list = new DeletedFileList(src);
		expect(await list.next()).toHaveLength(25);
		expect(src.listVersions).toHaveBeenCalledTimes(1);
		expect(paths(await list.next())).toEqual(['last.md']);
		expect(src.listVersions).toHaveBeenLastCalledWith({ cursor: 'next' });
		expect(list.hasMore).toBe(false);
	});

	it('sends the search to the server and also filters names on the device', async () => {
		// An encrypted vault cannot search on the server, so every name comes back.
		const src = source([{ versions: [version('Projects/Plan.md'), version('notes/other.md'), version('plans/q4.md')], hasMore: false }]);
		const rows = await new DeletedFileList(src, '  plan ').next();
		expect(src.listVersions).toHaveBeenCalledWith({ search: 'plan' });
		expect(paths(rows)).toEqual(['Projects/Plan.md', 'plans/q4.md']);
	});

	it('treats a page without a cursor as the last page', async () => {
		const src = source([{ versions: [version('a.md')], hasMore: true }]);
		const list = new DeletedFileList(src);
		await list.next();
		expect(list.hasMore).toBe(false);
	});
});
