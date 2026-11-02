import { describe, expect, it } from 'vitest';
import { exactArrayBuffer, readLimitedRequestBody } from './body-reader';

describe('bounded request body reader', () => {
	it('rejects an oversized Content-Length without reading the stream', async () => {
		const request = new Request('https://worker.test/upload', {
			method: 'POST',
			headers: { 'Content-Length': '11' },
			body: 'small',
			duplex: 'half',
		} as RequestInit);

		const result = await readLimitedRequestBody(request, 10);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('Expected an oversized response');
		expect(result.response.status).toBe(413);
	});

	it('stops consuming a chunked stream as soon as the limit is exceeded', async () => {
		let pulls = 0;
		const request = new Request('https://worker.test/upload', {
			method: 'POST',
			body: new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(6));
					if (pulls >= 3) controller.close();
				},
			}),
			duplex: 'half',
		} as RequestInit);

		const result = await readLimitedRequestBody(request, 10);

		expect(result.ok).toBe(false);
		expect(pulls).toBeLessThanOrEqual(2);
	});

	function chunked(chunks: number[], headers: Record<string, string> = {}) {
		let index = 0;
		return new Request('https://worker.test/upload', {
			method: 'POST', headers,
			body: new ReadableStream<Uint8Array>({ pull(controller) {
				if (index < chunks.length) controller.enqueue(new Uint8Array(chunks[index]!).fill(++index));
				else controller.close();
			} }),
			duplex: 'half',
		} as RequestInit);
	}

	it('copies a declared-length body into one exact buffer as chunks arrive', async () => {
		const result = await readLimitedRequestBody(chunked([3, 2, 4], { 'Content-Length': '9' }), 10);
		if (!result.ok) throw new Error('Expected a body');
		expect([...result.bytes]).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 3]);
		expect(exactArrayBuffer(result.bytes)).toBe(result.bytes.buffer);
	});

	it('rejects a body that does not match its declared length', async () => {
		for (const declared of ['8', '10']) {
			const result = await readLimitedRequestBody(chunked([3, 2, 4], { 'Content-Length': declared }), 10);
			expect(result.ok ? 200 : result.response.status).toBe(400);
		}
	});

	it('copies only partial views into a standalone buffer', () => {
		const view = new Uint8Array(new ArrayBuffer(8), 2, 3).fill(7);
		const copy = exactArrayBuffer(view);
		expect(copy).not.toBe(view.buffer);
		expect([...new Uint8Array(copy)]).toEqual([7, 7, 7]);
	});
});
