export class ReadingApiError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export type ReadingConnectionState = 'available' | 'paused' | 'not-configured';
export function readingConnectionState(error: unknown): ReadingConnectionState {
	if (!(error instanceof ReadingApiError)) return 'available';
	if (error.code === 'feature_paused') return 'paused';
	if (error.code === 'reading_not_configured') return 'not-configured';
	return 'available';
}
