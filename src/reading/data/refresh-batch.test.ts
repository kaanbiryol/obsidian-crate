import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadingRefresh } from './refresh-batch';

function harness(options: { active?: boolean; canRun?: () => boolean } = {}) {
	const controller = new AbortController();
	const maintenance = { start: vi.fn(async () => {}), changed: vi.fn(async (_paths: Iterable<string>) => {}), retry: vi.fn(async () => {}) };
	const library = { active: options.active ?? true, refreshPaths: vi.fn(async (_paths: Iterable<string>) => {}), refreshProperties: vi.fn(async (_paths: Iterable<string>) => {}) };
	const onError = vi.fn(), beforeRefresh = vi.fn();
	const refresh = createReadingRefresh({ maintenance, library, signal: controller.signal, canRun: options.canRun ?? (() => true), beforeRefresh, onError });
	return { controller, maintenance, library, onError, beforeRefresh, refresh };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createReadingRefresh', () => {
	it('starts background work on the first refresh, then refreshes changed cards', async () => {
		const h = harness();
		h.refresh.changed('Reading/a.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.beforeRefresh).toHaveBeenCalledOnce();
		expect(h.maintenance.start).toHaveBeenCalledOnce();
		expect(h.library.refreshPaths).toHaveBeenCalledWith(['Reading/a.md']);

		h.refresh.changed('Reading/b.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.maintenance.start).toHaveBeenCalledOnce();
		expect(h.library.refreshPaths).toHaveBeenLastCalledWith(['Reading/b.md']);
	});

	it('debounces a burst but refreshes within the maximum wait', async () => {
		const h = harness();
		for (let elapsed = 0; elapsed < 2_000; elapsed += 300) {
			h.refresh.changed(`Reading/${elapsed}.md`);
			await vi.advanceTimersByTimeAsync(300);
		}
		expect(h.library.refreshPaths).toHaveBeenCalledOnce();
		expect([...h.library.refreshPaths.mock.calls[0]![0]]).toHaveLength(7);
	});

	it('takes re-indexed cards from properties unless the note also changed, and checks them', async () => {
		const h = harness();
		h.refresh.reindexed('Reading/a.md');
		h.refresh.reindexed('Reading/b.md');
		h.refresh.changed('Reading/b.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.maintenance.changed).toHaveBeenCalledWith(['Reading/a.md', 'Reading/b.md']);
		expect(h.library.refreshPaths).toHaveBeenCalledWith(['Reading/b.md']);
		expect(h.library.refreshProperties).toHaveBeenCalledWith(['Reading/a.md']);
	});

	it('retries waiting work only when no note needs checking', async () => {
		const h = harness();
		h.refresh.schedule();
		await vi.advanceTimersByTimeAsync(400);
		h.refresh.retry();
		await vi.advanceTimersByTimeAsync(400);
		expect(h.maintenance.retry).toHaveBeenCalledOnce();

		h.refresh.retry();
		h.refresh.check('Reading/moved.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.maintenance.retry).toHaveBeenCalledOnce();
		expect(h.maintenance.changed).toHaveBeenCalledWith(['Reading/moved.md']);
	});

	it('leaves cards alone while the library is inactive', async () => {
		const h = harness({ active: false });
		h.refresh.changed('Reading/a.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.maintenance.start).toHaveBeenCalledOnce();
		expect(h.library.refreshPaths).not.toHaveBeenCalled();
	});

	it('keeps queued paths until it can run', async () => {
		let ready = false;
		const h = harness({ canRun: () => ready });
		h.refresh.changed('Reading/a.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.maintenance.start).not.toHaveBeenCalled();
		ready = true;
		h.refresh.schedule();
		await vi.advanceTimersByTimeAsync(400);
		expect(h.library.refreshPaths).toHaveBeenCalledWith(['Reading/a.md']);
	});

	it('reports failures, but not after abort, and stop waits for running work', async () => {
		const h = harness();
		h.maintenance.start.mockRejectedValueOnce(new Error('disk'));
		h.refresh.schedule();
		await vi.advanceTimersByTimeAsync(400);
		expect(h.onError).toHaveBeenCalledWith(new Error('disk'));

		let finish!: () => void;
		h.library.refreshPaths.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
		h.refresh.changed('Reading/a.md');
		await vi.advanceTimersByTimeAsync(400);
		let stopped = false;
		void h.refresh.stop().then(() => { stopped = true; });
		await vi.advanceTimersByTimeAsync(0);
		expect(stopped).toBe(false);
		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(stopped).toBe(true);

		h.controller.abort();
		h.refresh.changed('Reading/b.md');
		await vi.advanceTimersByTimeAsync(400);
		expect(h.library.refreshPaths).toHaveBeenCalledTimes(1);
	});
});
