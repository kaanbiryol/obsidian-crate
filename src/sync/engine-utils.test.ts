import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from './api';
import { retryWithBackoff, runConcurrentTasks } from './engine-utils';

describe('runConcurrentTasks', () => {
	it('stops launching new tasks when destroyed', async () => {
		let destroyed = false;
		const callOrder: number[] = [];
		const tasks = [
			async () => { callOrder.push(1); return 1; },
			async () => {
				callOrder.push(2);
				destroyed = true;
				return 2;
			},
			async () => { callOrder.push(3); return 3; },
			async () => { callOrder.push(4); return 4; },
		];

		await runConcurrentTasks(tasks, 1, () => destroyed);

		expect(callOrder).toEqual([1, 2]);
	});
});

describe('retryWithBackoff', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not retry after destroy', async () => {
		let destroyed = false;
		let callCount = 0;

		const fn = async () => {
			callCount += 1;
			if (callCount === 1) {
				destroyed = true;
				throw new Error('first failure');
			}
			return 'done';
		};

		await expect(
			retryWithBackoff(fn, {
				maxRetries: 3,
				baseDelayMs: 10,
				isAbortError: () => false,
				isDestroyed: () => destroyed,
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
			isAbortError: () => false,
			isDestroyed: () => false,
		});

		expect(callCount).toBe(1);
		await vi.advanceTimersByTimeAsync(2499);
		expect(callCount).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(promise).resolves.toBe('done');
		expect(callCount).toBe(2);
	});
});
