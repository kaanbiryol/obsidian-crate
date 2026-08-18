import { generateSecureToken } from '../sync/device-token';

function randomBase36(length: number): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let result = '';
	for (const value of bytes) {
		result += chars[value % chars.length];
	}
	return result;
}

function randomBoundary(): string {
	return `----crate-${randomBase36(12)}-${Date.now()}`;
}

export function createMultipartBody(parts: Array<{
	name: string;
	value: string;
	filename?: string;
	contentType?: string;
}>): { body: string; boundary: string } {
	const boundary = randomBoundary();
	const lines: string[] = [];

	for (const part of parts) {
		lines.push(`--${boundary}`);
		const disposition = part.filename
			? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`
			: `Content-Disposition: form-data; name="${part.name}"`;
		lines.push(disposition);
		if (part.contentType) {
			lines.push(`Content-Type: ${part.contentType}`);
		}
		lines.push('');
		lines.push(part.value);
	}

	lines.push(`--${boundary}--`);
	lines.push('');

	return {
		body: lines.join('\r\n'),
		boundary,
	};
}

export function generateAuthToken(): string {
	return generateSecureToken();
}

export function generateBucketName(prefix: string = 'crate'): string {
	return `${prefix}-${randomBase36(8)}`;
}

export function generateWorkerName(prefix: string = 'crate-sync'): string {
	return `${prefix}-${randomBase36(6)}`;
}
