import { extractionUrl } from '@/reading/extraction/url';
import { youtubeVideoId } from '@/reading/core/youtube';
import { youtubeMetadata, youtubeMetadataUrl, YOUTUBE_METADATA_MAX_BYTES } from '@/reading/extraction/youtube';
import type { CapturedArticle } from '@/reading/extraction/types';
export { extractionUrl, isPublicIPv4 } from '@/reading/extraction/url';

const MAX_BYTES = 2 * 1024 * 1024;
/** Cloudflare uses global_fetch_strictly_public. Local workerd supplies a native
 * network binding restricted to public addresses at connection time, including
 * DNS resolution. Never substitute Node's unrestricted fetch for that binding. */
export async function fetchArticle(source: string, fetchPublic: (request: Request) => Promise<Response> = fetch, ownOrigin?: string): Promise<{ html: string; url: string }> {
  return fetchResource(source, fetchPublic, ownOrigin);
}

/** Metadata uses the same bounded, public-only transport as article extraction. */
export async function fetchReadingCapture(source: string, fetchPublic: (request: Request) => Promise<Response> = fetch, ownOrigin?: string): Promise<{ article: CapturedArticle; url: string }> {
  const url = extractionUrl(source).href, videoId = youtubeVideoId(url);
  const resource = videoId ? await fetchResource(youtubeMetadataUrl(videoId), fetchPublic, ownOrigin, true) : await fetchArticle(url, fetchPublic, ownOrigin);
  if (videoId) return { article: youtubeMetadata(resource.html), url };
  // Failed downloads and video metadata need no DOM parser.
  const { extractDocument } = await import('./document');
  return { article: extractDocument(resource.html, resource.url), url: resource.url };
}

async function fetchResource(source: string, fetchPublic: (request: Request) => Promise<Response>, ownOrigin?: string, json = false): Promise<{ html: string; url: string }> {
  const signal = AbortSignal.timeout(15_000); let url = extractionUrl(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (ownOrigin && url.hostname === new URL(ownOrigin).hostname) throw new Error('Crate cannot extract its own server');
    const response = await fetchPublic(new Request(url, { signal, redirect: 'manual', credentials: 'omit', headers: {
      Accept: json ? 'application/json' : 'text/html, application/xhtml+xml', 'User-Agent': 'Crate/1.0 (read-it-later)',
    } }));
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('Location'); if (!location) break;
      url = extractionUrl(new URL(location, url).href); continue;
    }
    if (!response.ok || !(json ? /^application\/json\b/i : /^(text\/html|application\/xhtml\+xml)\b/i).test(response.headers.get('Content-Type') ?? '')) {
      await response.body?.cancel(); throw new Error(json ? 'Video details are unavailable.' : 'Page is not readable HTML');
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty page');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > (json ? YOUTUBE_METADATA_MAX_BYTES : MAX_BYTES)) throw new Error('Reading response too large'); chunks.push(value);
    } } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('Content-Type') ?? '')?.[1] ?? 'utf-8';
    return { html: new TextDecoder(charset).decode(bytes), url: url.href };
  }
  throw new Error('Too many redirects');
}
