import { extractDocument } from '../../src/reading/extraction/document';
export async function extractReadingDocument(html: string, source: string, transport?: (request: Request) => Promise<Response>) {
  if (new TextEncoder().encode(html).byteLength > 2 * 1024 * 1024) throw new Error('Article HTML exceeds 2 MB.');
  return extractDocument(html, source, transport);
}
