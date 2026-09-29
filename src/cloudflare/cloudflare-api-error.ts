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
