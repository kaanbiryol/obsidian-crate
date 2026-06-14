export function createAbortError(message: string): DOMException | Error {
	if (typeof DOMException === 'function') {
		return new DOMException(message, 'AbortError');
	}

	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

export function isAbortError(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'name' in error
		&& (error as { name?: unknown }).name === 'AbortError';
}
