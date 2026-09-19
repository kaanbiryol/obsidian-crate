import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLinkTitle } from './link-title';

const request = (url: string) => new Request('https://crate.example/links/title', {
	method: 'POST', headers: { Authorization: 'Bearer secret', Cookie: 'private=yes' }, body: JSON.stringify({ url }),
});
afterEach(() => vi.unstubAllGlobals());

describe('page title lookup', () => {
	it('reads a title without forwarding credentials or the fragment', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response('<html><head><title> Hello &amp; world </title></head></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
		vi.stubGlobal('fetch', fetcher);
		expect(await (await handleLinkTitle(request('https://example.com/page#private'))).json()).toEqual({ title: 'Hello &amp; world' });
		expect(fetcher).toHaveBeenCalledWith('https://example.com/page', expect.objectContaining({ redirect: 'manual', headers: { Accept: 'text/html' } }));
	});
	it.each(['http://localhost', 'http://127.1', 'http://2130706433', 'http://[::1]', 'http://192.168.0.1', 'https://user:pass@example.com', 'file:///etc/passwd', 'https://example.com:8443', 'http://host.internal'])('rejects %s before fetching', async url => {
		const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
		expect((await handleLinkTitle(request(url))).status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('validates redirect destinations and never follows private addresses', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }));
		vi.stubGlobal('fetch', fetcher);
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('follows relative redirects up to a fixed limit', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: '/next' } }));
		vi.stubGlobal('fetch', fetcher);
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
		expect(fetcher).toHaveBeenCalledTimes(4);
	});
	it.each([
		() => new Response('<title>not HTML</title>', { headers: { 'Content-Type': 'application/json' } }),
		() => new Response('<title>denied</title>', { status: 403, headers: { 'Content-Type': 'text/html' } }),
		() => new Response('x'.repeat(256 * 1024) + '<title>too late</title>', { headers: { 'Content-Type': 'text/html' } }),
		() => new Response('<html>No title</html>', { headers: { 'Content-Type': 'text/html' } }),
	])('leaves the URL unchanged for unusable responses', async response => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
	});
	it('silently falls back on network failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
	});
});

describe('page title request validation', () => {
	it.each([undefined, null, 42, [], {}, '', '/relative', 'not a URL', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com',
		'http://10.0.0.1', 'http://172.16.1.1', 'http://169.254.169.254/latest/meta-data', 'http://0x7f000001', 'http://0177.0.0.1',
		'http://[::ffff:127.0.0.1]', 'http://[fd00::1]', 'http://localhost.', 'http://foo.localhost', 'http://host.local',
		'http://host.internal.', 'http://host.onion', 'http://host.invalid', 'http://single-label', 'https://:secret@example.com',
		'https://example.com/' + 'a'.repeat(4096)])('rejects invalid or non-public destination %#', async url => {
		const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
		const response = await handleLinkTitle(new Request('https://crate.example/links/title', { method: 'POST', body: JSON.stringify({ url }) }));
		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each(['{', 'null', '[]', '42', '"https://example.com"'])('rejects malformed request bodies %s', async body => {
		const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
		expect((await handleLinkTitle(new Request('https://crate.example/links/title', { method: 'POST', body }))).status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('bounds the incoming JSON body before contacting a website', async () => {
		const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
		const response = await handleLinkTitle(new Request('https://crate.example/links/title', { method: 'POST', body: JSON.stringify({ url: 'https://example.com', extra: 'x'.repeat(8192) }) }));
		expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled();
	});
	it.each(['http://example.com:80/page', 'https://example.com:443/page', 'HTTPS://EXAMPLE.COM/page', 'https://例え.jp/記事'])('accepts public web URL %s', async url => {
		const fetcher = vi.fn().mockResolvedValue(new Response('<TITLE lang="en">Public page</TITLE>', { headers: { 'Content-Type': 'TEXT/HTML; charset=utf-8' } }));
		vi.stubGlobal('fetch', fetcher);
		const response = await handleLinkTitle(request(url));
		expect(await response.json()).toEqual({ title: 'Public page' });
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(fetcher).toHaveBeenCalledOnce();
	});
});

function streamingHtml(chunks: Uint8Array[], cancel = vi.fn()) {
	let index = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) { const chunk = chunks[index++]; if (chunk) controller.enqueue(chunk); else controller.close(); }, cancel,
	}, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/html' } });
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe('bounded streaming HTML and redirects', () => {
	it.each([301, 302, 303, 307, 308])('follows %i without forwarding private headers', async status => {
		const cancel = vi.fn();
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status, headers: { Location: '../article#section' } }))
			.mockResolvedValueOnce(streamingHtml([bytes('<title>Redirected</title>')]));
		vi.stubGlobal('fetch', fetcher);
		expect(await (await handleLinkTitle(request('https://example.com/start/path'))).json()).toEqual({ title: 'Redirected' });
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[1]?.[0]).toBe('https://example.com/article');
		for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ redirect: 'manual', headers: { Accept: 'text/html' } });
		expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(fetcher.mock.calls[1]?.[1]?.signal);
	});
	it.each(['http://169.254.169.254', 'https://user:pass@example.org', 'file:///secret', 'http://[::1]', 'http://host.internal', 'https://example.org:8443', 'http://[invalid'])('rejects redirected destination %s', async location => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: location } })); vi.stubGlobal('fetch', fetcher);
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it('handles a redirect with no location', async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302 })); vi.stubGlobal('fetch', fetcher);
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it('handles title delimiters and multibyte characters split across every byte', async () => {
		const html = bytes('<html><title>日本語 👩🏽‍💻 &amp; café</title><body>rest</body></html>');
		const cancel = vi.fn(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingHtml([...html].map(value => new Uint8Array([value])), cancel)));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: '日本語 👩🏽‍💻 &amp; café' });
		expect(cancel).toHaveBeenCalledOnce();
	});
	it.each([
		['<!-- <title>Comment</title> -->', '<title>Actual title</title>'],
		['<script>const text = "<title>Script</title>";', '</script><title>Actual title</title>'],
		['<style>/* <title>Style</title> */', '</style><title>Actual title</title>'],
		['<meta content="<title>Attribute</title>">', '<title>Actual title</title>'],
		['<textarea><title>Textarea text</title>', '</textarea><title>Actual title</title>'],
	])('ignores non-title content across stream chunks %#', async (...chunks) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingHtml(chunks.map(bytes))));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: 'Actual title' });
	});
	it('cancels an endless body at the byte limit', async () => {
		const cancel = vi.fn(); let reads = 0;
		const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(bytes('x'.repeat(65536))); }, cancel }, { highWaterMark: 0 });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } })));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
		expect(reads).toBe(4); expect(cancel).toHaveBeenCalledOnce();
	});
	it('discards a title that crosses the HTML byte budget', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingHtml([bytes(' '.repeat(256 * 1024 - 10) + '<title>Beyond limit</title>')])));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
	});
	it.each(['<title></title>', '<title> \n </title>', '<title>Incomplete', '<title>' + 'a'.repeat(4097) + '</title>'])('ignores empty, incomplete, or oversized titles %#', async html => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamingHtml([bytes(html)])));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
	});
	it('handles a failing body stream', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } }), { headers: { 'Content-Type': 'text/html' } })));
		expect(await (await handleLinkTitle(request('https://example.com'))).json()).toEqual({ title: null });
	});
	it('bounds stalled requests with a five-second abort signal', async () => {
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
		vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
			init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); started();
		})));
		try {
			const pending = handleLinkTitle(request('https://example.com')); await ready;
			expect(timeout).toHaveBeenCalledWith(5000);
			controller.abort(new DOMException('Timeout', 'TimeoutError'));
			expect(await (await pending).json()).toEqual({ title: null });
		} finally { timeout.mockRestore(); }
	});
});

it('aborts a stalled response body using the same lookup deadline', async () => {
	const controller = new AbortController();
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
	let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
	vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
		const body = new ReadableStream<Uint8Array>({ start(stream) {
			stream.enqueue(bytes('<html><head>'));
			init.signal!.addEventListener('abort', () => stream.error(new DOMException('Timed out', 'TimeoutError')), { once: true });
			started();
		} });
		return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
	}));
	try {
		const pending = handleLinkTitle(request('https://example.com')); await ready;
		controller.abort();
		expect(await (await pending).json()).toEqual({ title: null });
		expect(timeout).toHaveBeenCalledOnce(); expect(timeout).toHaveBeenCalledWith(5000);
	} finally { timeout.mockRestore(); }
});
