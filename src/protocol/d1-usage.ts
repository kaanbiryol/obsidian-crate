export const D1_USAGE_HEADER = 'X-Crate-D1-Usage';
export interface D1Usage { rowsRead: number; rowsWritten: number; complete: boolean }

/** Only server-reported, nonnegative integer counters belong in diagnostics. */
export function parseD1Usage(header: string | null): D1Usage | undefined {
  const match = header?.match(/^(\d+):(\d+):([01])$/);
  if (!match) return;
  const rowsRead = Number(match[1]), rowsWritten = Number(match[2]);
  if (!Number.isSafeInteger(rowsRead) || !Number.isSafeInteger(rowsWritten)) return;
  return { rowsRead, rowsWritten, complete: match[3] === '1' };
}
