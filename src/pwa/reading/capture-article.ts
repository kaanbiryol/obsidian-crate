import { extractionUrl } from '@/reading/extraction/url';
import type { CapturedArticle } from '@/reading/extraction/types';
import { youtubeVideoId } from '@/reading/core/youtube';
import { youtubeMetadata, youtubeMetadataUrl, YOUTUBE_METADATA_MAX_BYTES } from '@/reading/extraction/youtube';
/** Direct, credential-free download. CORS failures leave an encrypted bookmark
 * for an unlocked Obsidian device; URLs never go through the Crate server. */
export async function captureBrowserArticle(source: string): Promise<CapturedArticle> {
  const url = extractionUrl(source).href, videoId = youtubeVideoId(url);
  const response = await fetch(videoId ? youtubeMetadataUrl(videoId) : url, { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', signal: AbortSignal.timeout(15_000), ...(videoId ? { headers: { Accept: 'application/json' } } : {}) });
  if (!response.ok || !(videoId ? /^application\/json\b/i : /^(text\/html|application\/xhtml\+xml)\b/i).test(response.headers.get('Content-Type') ?? '')) throw new Error(videoId ? 'Video details are unavailable.' : 'Article download unavailable.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Article download unavailable.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > (videoId ? YOUTUBE_METADATA_MAX_BYTES : 2 * 1024 * 1024)) throw new Error('Reading content exceeds the download limit.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  if (videoId) {
    const article = youtubeMetadata(new TextDecoder().decode(bytes));
    const { withYoutubeTranscript } = await import('@/reading/extraction/youtube-transcript');
    const captured = await withYoutubeTranscript(article, videoId, request => fetch(request));
    return { ...captured, ...(!captured.markdown ? { deferTranscript: true as const } : {}) };
  }
  const { extractDocument } = await import('@/reading/extraction/document');
  return extractDocument(new TextDecoder().decode(bytes), response.url || source);
}
