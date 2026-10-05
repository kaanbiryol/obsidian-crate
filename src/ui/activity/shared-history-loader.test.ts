import { expect, it, vi } from 'vitest';
import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
import { SharedHistoryLoader } from './shared-history-loader';

const latest: SharedCheckpoint[] = [{ id: 'new', timestamp: '', expiresAt: 1, fileCount: 1, sequence: 1 }];

it('waits for the first server response even when local history is empty', async () => {
	let resolve!: (value: SharedCheckpoint[]) => void;
	const changed = vi.fn();
	const loader = new SharedHistoryLoader(() => new Promise(done => { resolve = done; }), changed);
	const pending = loader.refresh();
	expect(loader.getSnapshot()).toEqual({ ready: false });
	expect(changed).not.toHaveBeenCalled();
	resolve([]);
	await pending;
	expect(loader.getSnapshot()).toEqual({ ready: true, checkpoints: [] });
	expect(changed).toHaveBeenCalledOnce();
});

it('reveals local history after a failed initial request and allows a later retry', async () => {
	const load = vi.fn<() => Promise<SharedCheckpoint[]>>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(latest);
	const loader = new SharedHistoryLoader(load, vi.fn());
	await loader.refresh();
	expect(loader.getSnapshot()).toEqual({ ready: true });
	await loader.refresh();
	expect(loader.getSnapshot().checkpoints).toEqual(latest);
});

it('coalesces refreshes during an older request into one follow-up', async () => {
	let resolve!: (value: SharedCheckpoint[]) => void;
	const load = vi.fn<() => Promise<SharedCheckpoint[]>>()
		.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(latest);
	const loader = new SharedHistoryLoader(load, vi.fn());
	const first = loader.refresh();
	await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
	expect(load).toHaveBeenCalledOnce();
	resolve([]);
	await first;
	await vi.waitFor(() => expect(loader.getSnapshot().checkpoints).toEqual(latest));
	expect(load).toHaveBeenCalledTimes(2);
});

it('preserves previously loaded history when a refresh fails', async () => {
	const load = vi.fn<() => Promise<SharedCheckpoint[]>>().mockResolvedValueOnce(latest).mockRejectedValue(new Error('Offline'));
	const loader = new SharedHistoryLoader(load, vi.fn());
	await loader.refresh();
	await loader.refresh();
	expect(loader.getSnapshot()).toEqual({ ready: true, checkpoints: latest });
});

it('ignores an old view’s response and queued reload after disposal', async () => {
	let resolve!: (value: SharedCheckpoint[]) => void;
	const load = vi.fn<() => Promise<SharedCheckpoint[]>>(() => new Promise(done => { resolve = done; }));
	const changed = vi.fn();
	const loader = new SharedHistoryLoader(load, changed);
	const pending = loader.refresh();
	await loader.refresh();
	loader.dispose();
	const reopened = new SharedHistoryLoader(async () => latest, vi.fn());
	await reopened.refresh();
	resolve([]);
	await pending;
	await loader.refresh();
	expect(loader.getSnapshot()).toEqual({ ready: false });
	expect(changed).not.toHaveBeenCalled();
	expect(load).toHaveBeenCalledOnce();
	expect(reopened.getSnapshot().checkpoints).toEqual(latest);
});
