export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: number | null,
	) {
		super(message);
		this.name = 'CloudflareApiError';
	}
}

/** Cloudflare definitely refused the request, so it cannot still take effect.
 * A timeout, transport failure or server error leaves the outcome uncertain. */
export function isDefinitiveRejection(error: unknown): boolean {
	return error instanceof CloudflareApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/** Cloudflare answered that the resource does not exist. */
export function isNotFound(error: unknown): boolean {
	return error instanceof CloudflareApiError && error.status === 404;
}

/** Resolves a lookup whose 404 means the resource does not exist. */
export async function nullOn404<T>(request: Promise<T>): Promise<T | null> {
	try {
		return await request;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}
