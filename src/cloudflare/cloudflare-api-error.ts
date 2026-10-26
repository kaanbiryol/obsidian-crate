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
