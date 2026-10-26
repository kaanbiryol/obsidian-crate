import { describe, expect, it, vi } from 'vitest';
import { allowedExtractorUrl, extractorFetch } from './defuddle-fetch';

describe('extractorFetch', () => {
	it('rejects hosts outside the allowlist and unsafe URLs before any request', async () => {
		const transport = vi.fn(async () => new Response('ok'));
		const guarded = extractorFetch(transport);
		for (const url of ['https://example.com/', 'http://api.fxtwitter.com/a', 'https://c2.com:8443/', 'https://www.youtube.com/youtubei/v1/player']) {
			await expect(guarded(url)).rejects.toThrow('Unsupported extractor request');
		}
		expect(() => allowedExtractorUrl('https://user:pass@c2.com/')).toThrow('Unsupported extractor request');
		expect(transport).not.toHaveBeenCalled();
		expect(allowedExtractorUrl('https://i0.hdslb.com/sub.json').hostname).toBe('i0.hdslb.com');
	});

	it('checks every redirect hop and reports the final URL', async () => {
		const transport = vi.fn(async (request: Request) => request.url.startsWith('https://old.reddit.com/')
			? new Response(null, { status: 302, headers: { Location: 'https://www.reddit.com/login/' } })
			: new Response('login'));
		const response = await extractorFetch(transport)('https://old.reddit.com/r/a/comments/1/x/');
		expect(response.url).toBe('https://www.reddit.com/login/');
		expect(await response.text()).toBe('login');
		expect(transport.mock.calls.map(([request]) => [request.redirect, request.credentials])).toEqual([['manual', 'omit'], ['manual', 'omit']]);

		const escape = extractorFetch(async () => new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/' } }));
		await expect(escape('https://c2.com/wiki/remodel/pages/A')).rejects.toThrow('Unsupported extractor request');
	});

	it('forwards only content headers and caps responses and calls', async () => {
		const transport = vi.fn(async (_request: Request) => new Response('{}'));
		await extractorFetch(transport)('https://api.fxtwitter.com/a/status/1', { headers: { 'User-Agent': 'Defuddle', Cookie: 'session=1', Authorization: 'Bearer x' } });
		const sent = transport.mock.calls[0]![0].headers;
		expect([sent.get('User-Agent'), sent.get('Cookie'), sent.get('Authorization')]).toEqual(['Defuddle', null, null]);

		const large = extractorFetch(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
		await expect(large('https://c2.com/a')).rejects.toThrow('Extractor response too large');

		const counted = extractorFetch(async () => new Response('{}'));
		for (let call = 0; call < 8; call++) await counted('https://c2.com/a');
		await expect(counted('https://c2.com/a')).rejects.toThrow('Too many extractor requests');
	});
});
