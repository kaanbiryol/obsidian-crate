export const D1_USAGE_HEADER = 'X-Crate-D1-Usage';
/** `queries` counts D1 queries as Cloudflare's per-invocation limit does (a batch
 * counts once), summed over the invocations a request used. Older servers omit it. */
export interface D1Usage { rowsRead: number; rowsWritten: number; complete: boolean; queries?: number }

/** Only server-reported, nonnegative integer counters belong in diagnostics. */
export function parseD1Usage(header: string | null): D1Usage | undefined {
	const match = header?.match(/^(\d+):(\d+):([01])(?::(\d+))?$/);
	if (!match) return;
	const rowsRead = Number(match[1]), rowsWritten = Number(match[2]), queries = match[4] === undefined ? undefined : Number(match[4]);
	if (!Number.isSafeInteger(rowsRead) || !Number.isSafeInteger(rowsWritten) || (queries !== undefined && !Number.isSafeInteger(queries))) return;
	return { rowsRead, rowsWritten, complete: match[3] === '1', ...(queries === undefined ? {} : { queries }) };
}
