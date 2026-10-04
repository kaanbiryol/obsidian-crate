import type { CapturedArticle } from './types';
import { MAX_READING_BYTES } from '../core/model';
import { transcriptSegments } from '../core/transcript';

export type YoutubeFetch = (request: Request) => Promise<Response>;

/** Optional enrichment. Metadata remains usable if YouTube blocks captions.
 * Only this YouTube-specific extractor receives network access. */
export async function withYoutubeTranscript(article: CapturedArticle, id: string, fetchResource: YoutubeFetch, parent?: AbortSignal): Promise<CapturedArticle> {
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
	let calls = 0, bytes = 0;
	const boundedFetch: typeof fetch = async (input, init) => {
		signal.throwIfAborted();
		const request = new Request(input, init), url = new URL(request.url);
		if (++calls > 6 || url.protocol !== 'https:' || url.username || url.password || url.port
			|| !['www.youtube.com', 'youtube.com'].includes(url.hostname)
			|| !['/watch', '/youtubei/v1/player', '/youtubei/v1/next', '/api/timedtext'].includes(url.pathname)) throw new Error('Unsupported transcript request');
		const response = await fetchResource(new Request(url, { method: request.method, body: request.method === 'POST' ? await request.text() : undefined,
			headers: { Accept: 'text/html, application/json, application/xml, text/xml', ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
			credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal }));
		signal.throwIfAborted();
		if (!response.ok || !/^(text\/(html|xml|plain)|application\/(json|xml))\b/i.test(response.headers.get('Content-Type') ?? '')) {
			await response.body?.cancel(); throw new Error('Transcript unavailable');
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error('Empty transcript response');
		const chunks: Uint8Array[] = []; let size = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
				size += value.length; bytes += value.length;
				if (size > 2 * 1024 * 1024 || bytes > 5 * 1024 * 1024) throw new Error('Transcript response too large');
				chunks.push(value);
			}
		} finally { await reader.cancel(); }
		const buffer = new Uint8Array(size); let at = 0;
		for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; }
		return new Response(buffer, { headers: response.headers });
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([ (async () => {
			const url = `https://www.youtube.com/watch?v=${id}`;
			const response = await boundedFetch(url);
			// An oEmbed response or login wall is not a transcript.
			if (!/^text\/html\b/i.test(response.headers.get('Content-Type') ?? '')) return article;
			const [{ default: Defuddle }, { parseHTML }, { articleMarkdown }] = await Promise.all([import('defuddle/full'), import('linkedom'), import('./markdown')]);
			const document = parseHTML(await response.text()).document;
			const result = await new Defuddle(document, { url, useAsync: true, markdown: false, debug: false, fetch: boundedFetch }).parseAsync();
			signal.throwIfAborted();
			const extracted = parseHTML(`<html><body>${result.content}</body></html>`).document;
			// Defuddle deliberately removes presentation classes from its final HTML.
			// Its transcript variable establishes that captions were actually found.
			if (!result.variables?.transcript) return article;
			const markdown = articleMarkdown(extracted.body, url);
			if (!transcriptSegments(markdown).length || new TextEncoder().encode(markdown).length > MAX_READING_BYTES - 65536) return article;
			const language = result.variables.language;
			return { ...article, markdown, transcript: { source: 'youtube' as const,
				...(language && language.length <= 64 && /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(language) ? { language } : {}) } };
		})(), new Promise<CapturedArticle>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(article); }, 12_000); }) ]);
	} catch { parent?.throwIfAborted(); return article; }
	finally { clearTimeout(timer); controller.abort(); parent?.throwIfAborted(); }
}
