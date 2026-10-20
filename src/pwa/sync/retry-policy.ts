/** Automatic retries a pending command gets before it needs the user; a manual retry resets the budget. */
const AUTOMATIC_RETRY_LIMIT = 3;

export const hasAutomaticRetry = (attempts: number): boolean => attempts < AUTOMATIC_RETRY_LIMIT;

/** Doubles from two seconds after each failed attempt (attempts counts that failure). */
export const automaticRetryDelayMs = (attempts: number): number => 2_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 5);
