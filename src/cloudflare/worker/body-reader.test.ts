import { describe, expect, it } from 'vitest';
import { readLimitedRequestBody } from './body-reader';

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
});
