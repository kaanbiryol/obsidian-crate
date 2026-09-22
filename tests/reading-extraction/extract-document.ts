import { extractDocument } from '../../src/cloudflare/worker/reading/extraction/document';
export async function extractReadingDocument(html: string, source: string) {
  if (new TextEncoder().encode(html).byteLength > 2 * 1024 * 1024) throw new Error('Article HTML exceeds 2 MB.');
  return extractDocument(html, source);
}
