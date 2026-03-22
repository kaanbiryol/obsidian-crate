/**
 * Concurrency limiter for batch processing
 *
 * Processes items with a limited number of concurrent operations.
 * Useful for API calls where you want to parallelize but avoid overwhelming the server.
 */

interface ConcurrencyResult<R> {
  successes: R[];
  errors: Array<{ index: number; item: unknown; error: Error }>;
}

/**
 * Run async operations with a concurrency limit
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param concurrency - Maximum number of concurrent operations (default: 10)
 * @returns Object with successes array and errors array
 *
 * @example
 * const { successes, errors } = await runWithConcurrency(
 *   reminders,
 *   async (reminder) => syncToServer(reminder),
 *   10
 * );
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = 10
): Promise<ConcurrencyResult<R>> {
  const successes: R[] = [];
  const errors: Array<{ index: number; item: unknown; error: Error }> = [];

  // Process in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchStartIndex = i;

    const results = await Promise.allSettled(
      batch.map((item, batchIndex) =>
        fn(item).then((result) => ({
          result,
          index: batchStartIndex + batchIndex,
        }))
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        successes.push(result.value.result);
      } else {
        errors.push({
          index: batchStartIndex + j,
          item: batch[j],
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        });
      }
    }
  }

  return { successes, errors };
}
