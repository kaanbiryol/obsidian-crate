import { requestUrl } from 'obsidian';
import type { CapturedArticle } from './extraction/types';
import { extractionUrl } from './extraction/url';
import { decodeHtml } from './extraction/charset';
import { youtubeVideoId } from './core/youtube';
import { youtubeMetadata, youtubeMetadataUrl, YOUTUBE_METADATA_MAX_BYTES } from './extraction/youtube';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;
const UNREADABLE = 'The website did not return a readable article.';
const TOO_LARGE = 'This article exceeds the 2 MB download limit.';

/** Declared media types and sizes reject a link before its body downloads. */
function assertArticleHeaders(headers: Headers): void {
	const type = headers.get('Content-Type');
	if (type && !HTML_TYPE.test(type)) throw new Error(UNREADABLE);
	if (Number(headers.get('Content-Length')) > MAX_BYTES) throw new Error(TOO_LARGE);
}

/** Obsidian's native HTTP client bypasses browser CORS; no vault credentials are sent. */
export async function captureDesktopArticle(source: string, signal: AbortSignal): Promise<CapturedArticle> {
	signal.throwIfAborted();
	const sourceUrl = extractionUrl(source).href;
	const videoId = youtubeVideoId(sourceUrl);
	const url = videoId ? youtubeMetadataUrl(videoId) : sourceUrl;
	let timeout: number | undefined;
	let onAbort: (() => void) | undefined;
	try {
		// requestUrl cannot abort an in-flight download or expose its final redirect URL.
		// Bound the wait and reject late results before parsing or writing to the vault.
		const deadline = new Promise<never>((_resolve, reject) => {
			timeout = window.setTimeout(() => reject(new Error(videoId ? 'Video details timed out. Try again.' : 'Article download timed out. Try again.')), TIMEOUT_MS);
			onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Reading was closed.'));
			signal.addEventListener('abort', onAbort, { once: true });
		});
		const send = async <T>(request: Promise<T>): Promise<T> => {
			const result = await Promise.race([request, deadline]);
			signal.throwIfAborted();
			return result;
		};
		const accept = videoId ? 'application/json' : 'text/html, application/xhtml+xml';
		if (!videoId) {
			// requestUrl buffers the whole body, so a link to a large media file must be
			// rejected from its headers. Servers that refuse HEAD fall through to the GET.
			const head = await send(requestUrl({ url, method: 'HEAD', throw: false, headers: { Accept: accept } }).catch(() => null));
			if (head && head.status >= 200 && head.status < 300) assertArticleHeaders(new Headers(head.headers));
		}
		// Servers that honor Range send at most one byte over the limit; others send the whole page.
		const response = await send(requestUrl({ url, method: 'GET', throw: false,
			headers: { Accept: accept, ...(videoId ? {} : { Range: `bytes=0-${MAX_BYTES}` }) } }));
		const headers = new Headers(response.headers);
		if (videoId) {
			if (response.status < 200 || response.status >= 300 || !/^application\/json\b/i.test(headers.get('Content-Type') ?? '')
				|| response.arrayBuffer.byteLength > YOUTUBE_METADATA_MAX_BYTES) throw new Error('Video details are unavailable.');
			const article = youtubeMetadata(new TextDecoder().decode(response.arrayBuffer));
			const { withYoutubeTranscript } = await import('./extraction/youtube-transcript');
			const captured = await withYoutubeTranscript(article, videoId, async request => {
				signal.throwIfAborted(); request.signal.throwIfAborted();
				const result = await requestUrl({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), ...(request.method === 'POST' ? { body: await request.text() } : {}), throw: false });
				signal.throwIfAborted(); request.signal.throwIfAborted();
				if (result.arrayBuffer.byteLength > MAX_BYTES) throw new Error('Transcript response too large');
				return new Response(result.arrayBuffer, { status: result.status, headers: result.headers });
			}, signal);
			signal.throwIfAborted(); return captured;
		}
		if (response.status < 200 || response.status >= 300 || !HTML_TYPE.test(headers.get('Content-Type') ?? '')) throw new Error(UNREADABLE);
		if (response.status === 206) {
			// A partial page is complete only when its range reaches the end of the page.
			const range = /^bytes 0-(\d+)\/(\d+)$/i.exec(headers.get('Content-Range') ?? '');
			if (!range) throw new Error(UNREADABLE);
			if (Number(range[1]) + 1 !== Number(range[2])) throw new Error(Number(range[2]) > MAX_BYTES ? TOO_LARGE : UNREADABLE);
		}
		if (response.arrayBuffer.byteLength > MAX_BYTES) throw new Error(TOO_LARGE);
		const html = decodeHtml(response.arrayBuffer, headers.get('Content-Type'));
		const { extractDocument } = await import('./extraction/document');
		signal.throwIfAborted();
		// requestUrl follows redirects itself, so only the first hop is allowlisted here.
		return await extractDocument(html, url, async request => {
			signal.throwIfAborted();
			const result = await requestUrl({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers),
				...(request.method === 'POST' ? { body: await request.text() } : {}), throw: false });
			signal.throwIfAborted();
			if (result.arrayBuffer.byteLength > MAX_BYTES) throw new Error('Extractor response too large');
			return new Response(result.arrayBuffer, { status: result.status, headers: result.headers });
		});
	} finally {
		window.clearTimeout(timeout);
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}
