import { requestUrl } from 'obsidian';
import type {
	CloudflareCredentials,
	CloudflareEnvelope,
	CloudflareErrorBody,
	RawRequestOptions,
} from './api-types';

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export function formatCloudflareError(status: number, body: unknown): Error {
	if (body && typeof body === 'object') {
		const errorBody = body as CloudflareErrorBody;
		if (Array.isArray(errorBody.errors) && errorBody.errors.length > 0) {
			const message = errorBody.errors
				.map(e => e.message || 'Unknown Cloudflare API error')
				.join(', ');
			return new Error(`Cloudflare API error (${status}): ${message}`);
		}
	}

	return new Error(`Cloudflare API request failed with status ${status}`);
}

export async function cfRawRequest(
	credentials: CloudflareCredentials,
	path: string,
	options: RawRequestOptions = {}
): Promise<unknown> {
	const response = await requestUrl({
		url: `${CF_API_BASE}${path}`,
		method: options.method ?? 'GET',
		headers: {
			Authorization: `Bearer ${credentials.apiToken}`,
			...(options.headers || {}),
		},
		contentType: options.contentType,
		body: options.body,
		throw: false,
	});

	if (response.status >= 400) {
		throw formatCloudflareError(response.status, response.json);
	}

	return response.json as unknown;
}

export async function cfRequestVoid(
	credentials: CloudflareCredentials,
	path: string,
	options: RawRequestOptions = {}
): Promise<void> {
	await cfRawRequest(credentials, path, options);
}

export async function cfRequest<T>(
	credentials: CloudflareCredentials,
	path: string,
	options: RawRequestOptions = {}
): Promise<T> {
	const json = await cfRawRequest(credentials, path, {
		contentType: options.contentType || 'application/json',
		...options,
	});

	if (!json || typeof json !== 'object') {
		throw new Error('Cloudflare API returned an invalid response');
	}

	const payload = json as CloudflareEnvelope<T>;
	if (!payload.success) {
		throw formatCloudflareError(200, payload);
	}

	return payload.result;
}
