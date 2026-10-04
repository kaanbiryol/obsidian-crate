import { requestUrl } from 'obsidian';
import type { CapturedArticle } from './extraction/types';
import { extractionUrl } from './extraction/url';
import { youtubeVideoId } from './core/youtube';
import { youtubeMetadata, youtubeMetadataUrl, YOUTUBE_METADATA_MAX_BYTES } from './extraction/youtube';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

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
    const response = await Promise.race([
      requestUrl({ url, method: 'GET', throw: false, headers: { Accept: videoId ? 'application/json' : 'text/html, application/xhtml+xml' } }),
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => reject(new Error(videoId ? 'Video details timed out. Try again.' : 'Article download timed out. Try again.')), TIMEOUT_MS);
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Reading was closed.'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
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
    if (response.status < 200 || response.status >= 300 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(headers.get('Content-Type') ?? '')) {
      throw new Error('The website did not return a readable article.');
    }
    if (response.arrayBuffer.byteLength > MAX_BYTES) throw new Error('This article exceeds the 2 MB download limit.');
    const charset = /charset=["']?([\w-]+)/i.exec(headers.get('Content-Type') ?? '')?.[1] ?? 'utf-8';
    const html = new TextDecoder(charset).decode(response.arrayBuffer);
    const { extractDocument } = await import('./extraction/document');
    signal.throwIfAborted();
    return extractDocument(html, url);
  } finally {
    window.clearTimeout(timeout);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
