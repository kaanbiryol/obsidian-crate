export class ReadingApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export type ReadingConnectionState = 'available' | 'paused' | 'not-configured';
export function readingConnectionState(error: unknown): ReadingConnectionState {
  if (!(error instanceof ReadingApiError)) return 'available';
  if (error.code === 'feature_paused') return 'paused';
  if (error.code === 'reading_not_configured') return 'not-configured';
  // Older servers supplied a generic reading_error code. Keep their exact
  // messages at this compatibility boundary, outside component state decisions.
  if (error.code === undefined || error.code === 'reading_error') {
    if (error.message === 'Reading is disabled. Enable it in Crate settings.' || error.message === 'Reading is paused. Enable it in Crate settings.') return 'paused';
    if (error.message === 'Choose a Reading folder in Obsidian’s Crate settings first.') return 'not-configured';
  }
  return 'available';
}
