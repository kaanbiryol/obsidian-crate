import { extractionUrl } from '@/reading/extraction/url';
import type { CapturedArticle } from '@/reading/extraction/types';
/** Direct, credential-free download. CORS failures leave an encrypted bookmark
 * for an unlocked Obsidian device; URLs never go through the Crate server. */
export async function captureBrowserArticle(source: string): Promise<CapturedArticle> {
  const response = await fetch(extractionUrl(source).href, { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('Article download unavailable.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Article download unavailable.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 2 * 1024 * 1024) throw new Error('Article exceeds the download limit.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  const { extractDocument } = await import('@/reading/extraction/document');
  return extractDocument(new TextDecoder().decode(bytes), response.url || source);
}
