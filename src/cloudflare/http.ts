import { requestUrl } from 'obsidian';

export const API_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** A JSON object response body, or null for any other JSON value or unparsable text. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch { return null; }
}

export interface HttpRequest {
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

interface HttpResponse {
 arrayBuffer?: ArrayBuffer;
	headers?: Record<string, string>;
	status: number;
	text: string;
}

export type HttpTransport = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export const cloudflareHttpTransport: HttpTransport = async (url, request) => {
	let timeout: number | undefined;
	try {
	const response = await Promise.race([requestUrl({
		url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	}), new Promise<never>((_resolve, reject) => {
				timeout = window.setTimeout(() => reject(new Error('Cloudflare did not respond within 60 seconds. The request may still finish remotely.')), 60_000);
		})]);
	return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer, headers: response.headers };
		} finally {
				if (timeout !== undefined) window.clearTimeout(timeout);
		}
};
