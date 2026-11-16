import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from './worker-api/client';
import { retryWithBackoff, runConcurrentTasks } from './concurrency';
import { createAbortError } from './abort';

const destroy = (controller: AbortController) => controller.abort(createAbortError('Sync engine destroyed'));

describe('runConcurrentTasks', () => {
	it('drains started workers before rejecting and launches no further work after failure', async () => {
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const lateWrite = vi.fn();
		const neverStarted = vi.fn(async () => {});
		let settled = false;
		const run = runConcurrentTasks([
			async () => { throw new Error('Request aborted'); },
			async () => { await blocked; lateWrite(); },
			neverStarted,
		], 2);
		const assertion = expect(run).rejects.toThrow('Request aborted');
		void run.then(() => { settled = true; }, () => { settled = true; });
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await assertion;
		expect(lateWrite).toHaveBeenCalledOnce();
		expect(neverStarted).not.toHaveBeenCalled();
	});
	it('rejects with an abort and launches no further work when destroyed between tasks', async () => {
		const controller = new AbortController();
		const callOrder: number[] = [];
		const tasks = [
			async () => { callOrder.push(1); return 1; },
			async () => {
				callOrder.push(2);
				destroy(controller);
				return 2;
			},
			async () => { callOrder.push(3); return 3; },
			async () => { callOrder.push(4); return 4; },
		];

		await expect(runConcurrentTasks(tasks, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

		expect(callOrder).toEqual([1, 2]);
	});

	it('drains a task already running when destroyed before rejecting', async () => {
		const controller = new AbortController();
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const lateWrite = vi.fn();
		const neverStarted = vi.fn(async () => {});
		const run = runConcurrentTasks([
			async () => { await Promise.resolve(); destroy(controller); },
			async () => { await blocked; lateWrite(); },
			neverStarted,
		], 2, controller.signal);
		const assertion = expect(run).rejects.toMatchObject({ name: 'AbortError' });
		await Promise.resolve();
		release();
		await assertion;
		expect(lateWrite).toHaveBeenCalledOnce();
		expect(neverStarted).not.toHaveBeenCalled();
	});

	it('resolves every result when destroyed after the last task started', async () => {
		const controller = new AbortController();
		await expect(runConcurrentTasks([
			async () => 1,
			async () => { destroy(controller); return 2; },
		], 2, controller.signal)).resolves.toEqual([1, 2]);
	});
});

describe('retryWithBackoff', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not retry after destroy', async () => {
		const controller = new AbortController();
		let callCount = 0;

		const fn = async () => {
			callCount += 1;
			if (callCount === 1) {
				destroy(controller);
				throw new Error('first failure');
			}
			return 'done';
		};

		await expect(
			retryWithBackoff(fn, {
				maxRetries: 3,
				baseDelayMs: 10,
				signal: controller.signal,
			}),
		).rejects.toThrow('first failure');

		expect(callCount).toBe(1);
	});

	it('honours retryAfter delays from HttpError responses', async () => {
		vi.useFakeTimers();
		let callCount = 0;

		const fn = vi.fn(async () => {
			callCount += 1;
			if (callCount === 1) {
				throw new HttpError('retry later', 429, 2500);
			}
			return 'done';
		});

		const promise = retryWithBackoff(fn, {
			maxRetries: 3,
			baseDelayMs: 10,
			signal: new AbortController().signal,
		});

		expect(callCount).toBe(1);
		await vi.advanceTimersByTimeAsync(2499);
		expect(callCount).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toBe('done');
		expect(callCount).toBe(2);
	});

	it('does not retry permanent HTTP failures', async () => {
		const fn = vi.fn(async () => {
			throw new HttpError('conflict', 409);
		});

		await expect(retryWithBackoff(fn, {
			maxRetries: 3,
			baseDelayMs: 10,
			signal: new AbortController().signal,
		})).rejects.toThrow('conflict');

		expect(fn).toHaveBeenCalledTimes(1);
	});
});
