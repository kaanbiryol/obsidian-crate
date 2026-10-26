export type ExtractorTransport = (request: Request) => Promise<Response>;

/** Hosts Defuddle 0.19.5 async extractors call for X, Reddit, Bilibili and C2 wiki.
 * YouTube is excluded: Crate fetches transcripts through its own bounded client. */
const HOSTS = new Set(['publish.twitter.com', 'api.fxtwitter.com', 'old.reddit.com', 'www.reddit.com', 'c2.com', 'api.bilibili.com', 'player.bilibili.com']);
const MAX_CALLS = 8, MAX_REDIRECTS = 3, MAX_BYTES = 2 * 1024 * 1024, TIMEOUT_MS = 15_000;

export function allowedExtractorUrl(value: string): URL {
	const url = new URL(value), host = url.hostname.toLowerCase();
	if (url.protocol !== 'https:' || url.username || url.password || url.port
		|| !(HOSTS.has(host) || host.endsWith('.hdslb.com'))) throw new Error('Unsupported extractor request');
	return url;
}

/** Defuddle's extractors choose their own URLs, so every request and redirect hop
 * is checked against the allowlist. Cookies are never sent and responses are capped. */
export function extractorFetch(transport: ExtractorTransport): typeof fetch {
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	let calls = 0;
	return async (input, init) => {
		const original = new Request(input, init);
		const body = original.method === 'GET' || original.method === 'HEAD' ? undefined : await original.text();
		const headers = new Headers();
		for (const name of ['Accept', 'Accept-Language', 'Content-Type', 'User-Agent']) {
			const value = original.headers.get(name); if (value) headers.set(name, value);
		}
		let url = allowedExtractorUrl(original.url);
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
			if (++calls > MAX_CALLS) throw new Error('Too many extractor requests');
			const response = await transport(new Request(url, { method: original.method, body, headers, signal: AbortSignal.any([signal, original.signal]),
				redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' }));
			const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get('Location') : null;
			if (location) { await response.body?.cancel(); url = allowedExtractorUrl(new URL(location, url).href); continue; }
			const reader = response.body?.getReader();
			const chunks: Uint8Array[] = []; let size = 0;
			if (reader) try { for (;;) {
				const { done, value } = await reader.read(); if (done) break;
				size += value.length; if (size > MAX_BYTES) throw new Error('Extractor response too large'); chunks.push(value);
			} } finally { await reader.cancel(); }
			const bytes = new Uint8Array(size); let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
			const result = new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
			// Reddit detects its login wall from the final redirect URL.
			Object.defineProperty(result, 'url', { value: url.href });
			return result;
		}
		throw new Error('Too many extractor redirects');
	};
}
