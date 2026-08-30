import { corsResponse } from './cors';

type LimitedBodyResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; response: Response };

export async function readLimitedRequestBody(
	request: Request,
	maxBytes: number,
	tooLargeMessage = 'Request body too large',
): Promise<LimitedBodyResult> {
	const contentLength = request.headers.get('Content-Length');
	if (contentLength) {
		const declaredBytes = /^\d+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
		if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
			return { ok: false, response: corsResponse({ error: 'Invalid Content-Length header' }, 400) };
		}
		if (declaredBytes > maxBytes) {
			return { ok: false, response: corsResponse({ error: tooLargeMessage }, 413) };
		}
	}

	if (!request.body) return { ok: true, bytes: new Uint8Array() };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('Request body exceeded configured limit').catch(() => undefined);
				return { ok: false, response: corsResponse({ error: tooLargeMessage }, 413) };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	if (chunks.length === 1) return { ok: true, bytes: chunks[0]! };
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}
