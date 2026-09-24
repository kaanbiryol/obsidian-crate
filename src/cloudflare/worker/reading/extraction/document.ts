import Defuddle from 'defuddle/full';
import { parseHTML } from 'linkedom';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { articleMarkdown } from './markdown';
import { prepareDocumentIds } from './document-ids';
import { extractServerRenderedPost, isXPost } from './x-post';
import { discoverFaviconUrl } from './favicon';

/** Extract locally: neither Defuddle nor Markdown conversion may fetch resources. */
export function extractDocument(html: string, url: string): { markdown: string; title?: string; author?: string; faviconUrl?: string } {
  const document = parseHTML(html).document as unknown as Document;
  const faviconUrl = discoverFaviconUrl(document, url);
  const post = extractServerRenderedPost(document, url);
  const restoreIds = prepareDocumentIds(document);
  // First request HTML so we can restore fragment IDs and validate links/media
  // before passing it to Defuddle's own Markdown converter in articleMarkdown.
  // Retain JSON-LD until Defuddle reads metadata; its parser removes scripts.
  const result = post ?? new Defuddle(document, {
    url, useAsync: false, markdown: false, debug: false, includeReplies: false,
    // These heuristic passes delete short article lists and repeated project
    // headings. Keep structural cleanup, but preserve those authored sections.
    removeLowScoring: false, removeContentPatterns: false,
    fetch: () => Promise.reject(new Error('Extractor network access is disabled')),
  }).parse();
  // An unrecognized X page is generally a login shell, not a readable article.
  if (isXPost(url) && !post && !('extractorType' in result && result.extractorType)) throw new Error('No usable post text');
  const extracted = parseHTML(`<html><body>${result.content}</body></html>`).document as unknown as Document;
  restoreIds(extracted);
  const text = articleMarkdown(extracted.body, url);
  if (text.length < 40 || new TextEncoder().encode(text).length > MAX_READING_BYTES - 65536) throw new Error('No usable article text');
  return { markdown: text, title: result.title?.slice(0, 1000) || undefined, author: result.author?.slice(0, 1000) || undefined,
    ...(faviconUrl ? { faviconUrl } : {}) };
}
