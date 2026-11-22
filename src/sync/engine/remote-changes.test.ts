import { describe, expect, it, vi } from 'vitest';
import type { ChangelogEntry, CheckResponse, FileEntry } from '../../protocol/sync-types';
import { hasRemoteChanges, type RemoteChangesProgress } from './remote-changes';

const put = (path: string, hash: string, seq: number, size = 10): ChangelogEntry => ({ seq, path, action: 'put', hash, size, created_at: '2026-01-01T00:00:00Z' });
const remove = (path: string, seq: number): ChangelogEntry => ({ seq, path, action: 'delete', hash: '', size: 0, created_at: '2026-01-01T00:00:00Z' });
const FILE_LIMIT = 25 * 1024 * 1024;
const baseline = (hash: string): FileEntry => ({ hash, size: 10, modified: '2026-01-01T00:00:00Z' });

function context(options: { check?: Partial<Pick<CheckResponse, 'hasChanges' | 'cursorExpired'>>; changes?: ChangelogEntry[]; baselines?: Record<string, FileEntry>; lastSeq?: number }) {
	const getChanges = vi.fn(async (_since: number) => ({ changes: options.changes ?? [], lastSeq: 20, hasMore: false }));
	const checkForChanges = vi.fn(async (_since: number): Promise<CheckResponse> => ({ lastSeq: 20, hasChanges: true, storageId: 'storage-1', ...options.check }));
	const state = { progress: null as RemoteChangesProgress | null };
	return {
		getChanges,
		checkForChanges,
		state,
		context: {
			lastSeq: options.lastSeq ?? 10,
			get progress() { return state.progress; },
			setProgress: (progress: RemoteChangesProgress) => { state.progress = progress; },
			checkForChanges,
			files: { getChanges },
			getBaseline: (path: string) => options.baselines?.[path],
			shouldIgnore: (path: string) => path.startsWith('.trash/'),
			maxFileBytes: () => FILE_LIMIT,
			signal: new AbortController().signal,
		},
	};
}

describe('hasRemoteChanges', () => {
	it('reads only the cheap check when nothing follows the cursor', async () => {
		const { context: ctx, getChanges } = context({ check: { hasChanges: false } });
		await expect(hasRemoteChanges(ctx)).resolves.toBe(false);
		expect(getChanges).not.toHaveBeenCalled();
	});

	it('does not check a device that never synced', async () => {
		const { context: ctx, checkForChanges } = context({ lastSeq: 0 });
		await expect(hasRemoteChanges(ctx)).resolves.toBe(false);
		expect(checkForChanges).not.toHaveBeenCalled();
	});

	it('treats an expired cursor as remote changes', async () => {
		await expect(hasRemoteChanges(context({ check: { cursorExpired: true, hasChanges: false } }).context)).resolves.toBe(true);
		const { context: ctx, getChanges } = context({});
		getChanges.mockResolvedValueOnce({ changes: [], lastSeq: 20, hasMore: false, cursorExpired: true } as never);
		await expect(hasRemoteChanges(ctx)).resolves.toBe(true);
	});

	it("ignores this device's own uploads and deletes that follow the saved cursor", async () => {
		const { context: ctx } = context({
			changes: [put('a.md', 'old', 11), put('a.md', 'mine', 12), remove('gone.md', 13), put('.trash/x.md', 'other', 14), put('big.bin', 'other', 15, FILE_LIMIT + 1)],
			baselines: { 'a.md': baseline('mine') },
		});
		await expect(hasRemoteChanges(ctx)).resolves.toBe(false);
	});

	it.each([
		['an edit from another device', [put('a.md', 'theirs', 11)], { 'a.md': baseline('mine') }],
		['a new file from another device', [put('new.md', 'theirs', 11)], {}],
		['a delete of a synced file', [remove('a.md', 11)], { 'a.md': baseline('mine') }],
	])('reports %s', async (_name, changes, baselines) => {
		await expect(hasRemoteChanges(context({ changes, baselines }).context)).resolves.toBe(true);
	});

	it("reads this device's own uploads once, then checks only what follows them", async () => {
		const { context: ctx, getChanges, checkForChanges } = context({ changes: [put('a.md', 'mine', 11)], baselines: { 'a.md': baseline('mine') } });
		await expect(hasRemoteChanges(ctx)).resolves.toBe(false);
		await expect(hasRemoteChanges(ctx)).resolves.toBe(false);
		expect(checkForChanges.mock.calls.map(([since]) => since)).toEqual([10, 20]);
		expect(getChanges.mock.calls.map(([since]) => since)).toEqual([10, 20]);
	});

	it('reads from the saved cursor again once a sync moves it', async () => {
		const harness = context({ changes: [put('a.md', 'mine', 11)], baselines: { 'a.md': baseline('mine') } });
		await hasRemoteChanges(harness.context);
		await hasRemoteChanges({ ...harness.context, lastSeq: 15, progress: harness.state.progress });
		expect(harness.checkForChanges.mock.calls.at(-1)?.[0]).toBe(15);
	});

	it('keeps reading from the cursor while remote changes are found', async () => {
		const { context: ctx, checkForChanges, state } = context({ changes: [put('new.md', 'theirs', 11)] });
		await expect(hasRemoteChanges(ctx)).resolves.toBe(true);
		expect(state.progress).toBeNull();
		await hasRemoteChanges(ctx);
		expect(checkForChanges.mock.calls.map(([since]) => since)).toEqual([10, 10]);
	});
});
