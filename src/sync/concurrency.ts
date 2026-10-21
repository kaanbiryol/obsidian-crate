import { createLogger } from './logger';
import { createAbortError, isAbortError } from './abort';
import { HttpError } from './worker-api/http';
import { isRetryableSyncError } from './failures';

const logger = createLogger('SyncEngine');
const MAX_SERVER_RETRY_DELAY_MS = 60_000;

export async function runConcurrentTasks<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
	isDestroyed: () => boolean
): Promise<T[]> {
	const results: T[] = [];
	let index = 0;
	let failed = false;

	async function next(): Promise<void> {
		while (index < tasks.length) {
			if (isDestroyed() || failed) break;
			const currentIndex = index++;
			const task = tasks[currentIndex];
			if (!task) break;
			try {
				results[currentIndex] = await task();
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	}

	const workers = await Promise.allSettled(Array.from(
		{ length: Math.min(concurrency, tasks.length) },
		() => next(),
	));
	const failure = workers.find(worker => worker.status === 'rejected');
	if (failure?.status === 'rejected') throw failure.reason;
	return results;
}

export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: {
		maxRetries: number;
		baseDelayMs: number;
		isDestroyed: () => boolean;
	}
): Promise<T> {
	for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (isAbortError(error) || options.isDestroyed()) throw error;
			if (!isRetryableSyncError(error)) throw error;
			if (attempt === options.maxRetries) throw error;
			let delay: number;
			if (error instanceof HttpError && error.retryAfter !== null) {
				delay = Math.min(error.retryAfter, MAX_SERVER_RETRY_DELAY_MS);
			} else {
				const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt);
				delay = Math.round(exponentialDelay * (0.75 + Math.random() * 0.5));
			}
			logger.warn(`Retry ${attempt + 1}/${options.maxRetries} after ${delay}ms`);
			let remaining = delay;
			while (remaining > 0) {
				if (options.isDestroyed()) throw createAbortError('Sync retry aborted');
				const interval = Math.min(remaining, 250);
				await new Promise(resolve => setTimeout(resolve, interval));
				remaining -= interval;
			}
		}
	}

	throw new Error('Unreachable');
}
