import { readingUrl } from '@/reading/core/model';

const MAX_BYTES = 2 * 1024 * 1024;
export function isPublicIPv4(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number) as [number, number, number, number];
  if ([a, b, c, d].some(part => part > 255) || a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return false;
  if (a === 192 && (b === 0 || b === 2 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false;
  return true;
}
export function extractionUrl(value: string): URL {
  const url = new URL(readingUrl(value)), host = url.hostname.toLowerCase();
  if (url.port || host.includes(':') || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host)) throw new Error('Unsupported destination');
  if (/^[\d.]+$/.test(host) && !isPublicIPv4(host)) throw new Error('Private destination');
  url.hash = '';
  return url;
}

/** Cloudflare uses global_fetch_strictly_public. Local workerd supplies a native
 * network binding restricted to public addresses at connection time, including
 * DNS resolution. Never substitute Node's unrestricted fetch for that binding. */
export async function fetchArticle(source: string, fetchPublic: (request: Request) => Promise<Response> = fetch, ownOrigin?: string): Promise<{ html: string; url: string }> {
  const signal = AbortSignal.timeout(15_000); let url = extractionUrl(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (ownOrigin && url.hostname === new URL(ownOrigin).hostname) throw new Error('Crate cannot extract its own server');
    const response = await fetchPublic(new Request(url, { signal, redirect: 'manual', credentials: 'omit', headers: {
      Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'Crate/1.0 (read-it-later)',
    } }));
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('Location'); if (!location) break;
      url = extractionUrl(new URL(location, url).href); continue;
    }
    if (!response.ok || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('Content-Type') ?? '')) {
      await response.body?.cancel(); throw new Error('Page is not readable HTML');
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty page');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_BYTES) throw new Error('Article too large'); chunks.push(value);
    } } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('Content-Type') ?? '')?.[1] ?? 'utf-8';
    return { html: new TextDecoder(charset).decode(bytes), url: url.href };
  }
  throw new Error('Too many redirects');
}
