import { corsResponse } from './cors';

type LimitedBodyResult =
	| { ok: true; bytes: Uint8Array<ArrayBuffer> }
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
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	// A declared length lets chunks be copied into place as they arrive, so the
	// body is held once rather than as chunks plus a joined copy.
	const declared = contentLength ? Number(contentLength) : null;
	const target = declared !== null && declared > 0 ? new Uint8Array(declared) : null;
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (totalBytes + value.byteLength > maxBytes || (target && totalBytes + value.byteLength > target.byteLength)) {
				await reader.cancel('Request body exceeded configured limit').catch(() => undefined);
				return { ok: false, response: corsResponse({ error: target ? 'Request body does not match Content-Length' : tooLargeMessage }, target ? 400 : 413) };
			}
			if (target) target.set(value, totalBytes);
			else chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	if (target) {
		if (totalBytes !== target.byteLength) return { ok: false, response: corsResponse({ error: 'Request body does not match Content-Length' }, 400) };
		return { ok: true, bytes: target };
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

/** The bytes as a standalone ArrayBuffer, copying only when they are a partial view. */
export function exactArrayBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? bytes.buffer
		: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
