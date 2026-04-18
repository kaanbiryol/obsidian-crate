import { HttpError } from './api';
import { createLogger } from '../plugin/logger';

const logger = createLogger('SyncEngine');

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
			if (attempt === options.maxRetries) throw error;
			let delay: number;
			if (error instanceof HttpError && error.retryAfter !== null) {
				delay = error.retryAfter;
			} else {
				delay = options.baseDelayMs * Math.pow(2, attempt);
			}
			logger.warn(`Retry ${attempt + 1}/${options.maxRetries} after ${delay}ms`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}

	throw new Error('Unreachable');
}
