import { requestUrl } from 'obsidian';

export interface HttpRequest {
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

interface HttpResponse {
 arrayBuffer?: ArrayBuffer;
	status: number;
	text: string;
}

export type HttpTransport = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export const obsidianHttpTransport: HttpTransport = async (url, request) => {
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
	return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
    } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
    }
};
