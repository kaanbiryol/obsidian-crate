import { requestUrl } from 'obsidian';

export interface HttpRequest {
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

interface HttpResponse {
	status: number;
	text: string;
}

export type HttpTransport = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export const obsidianHttpTransport: HttpTransport = async (url, request) => {
	const response = await requestUrl({
		url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	return { status: response.status, text: response.text };
};
