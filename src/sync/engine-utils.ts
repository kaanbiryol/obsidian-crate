import { HttpError } from './api';
import { createLogger } from '../plugin/logger';
import { createAbortError } from './abort';

const logger = createLogger('SyncEngine');
const MAX_SERVER_RETRY_DELAY_MS = 60_000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableSyncError(error: unknown): boolean {
	return !(error instanceof HttpError) || RETRYABLE_HTTP_STATUSES.has(error.status);
}

export async function runConcurrentTasks<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
	isDestroyed: () => boolean
): Promise<T[]> {
	const results: T[] = [];
	let index = 0;

	async function next(): Promise<void> {
		while (index < tasks.length) {
			if (isDestroyed()) break;
			const currentIndex = index++;
			const task = tasks[currentIndex];
			if (!task) break;
			results[currentIndex] = await task();
		}
	}

	await Promise.all(Array.from(
		{ length: Math.min(concurrency, tasks.length) },
		() => next(),
	));
	return results;
}

export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: {
		maxRetries: number;
		baseDelayMs: number;
		isAbortError: (error: unknown) => boolean;
		isDestroyed: () => boolean;
	}
): Promise<T> {
	for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (options.isAbortError(error) || options.isDestroyed()) throw error;
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
