import type { CapturedArticle } from './types';
import Defuddle from 'defuddle/full';
import { parseHTML } from 'linkedom';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { articleMarkdown } from './markdown';
import { extractServerRenderedPost, isXPost } from './x-post';
import { discoverFaviconUrl } from './favicon';
import { extractorFetch, type ExtractorTransport } from './defuddle-fetch';

/** Defuddle's async extractors may reach only allowlisted hosts through
 * `transport`; without one, extraction stays local. Markdown conversion never fetches. */
export async function extractDocument(html: string, url: string, transport?: ExtractorTransport): Promise<CapturedArticle> {
  const document = parseHTML(html).document;
  const faviconUrl = discoverFaviconUrl(document, url);
  const post = extractServerRenderedPost(document, url);
  // First request HTML so we can validate links/media before passing it to
  // Defuddle's own Markdown converter in articleMarkdown.
  // Retain JSON-LD until Defuddle reads metadata; its parser removes scripts.
  const result = post ?? await new Defuddle(document, {
    url, useAsync: !!transport,
    // These heuristic passes delete short article lists and repeated project
    // headings. Keep structural cleanup, but preserve those authored sections.
    removeLowScoring: false, removeContentPatterns: false,
    fetch: transport ? extractorFetch(transport) : () => Promise.reject(new Error('Extractor network access is disabled')),
  }).parseAsync();
  // An unrecognized X page is generally a login shell, not a readable article.
  if (isXPost(url) && !post && !('extractorType' in result && result.extractorType)) throw new Error('No usable post text');
  const extracted = parseHTML(`<html><body>${result.content}</body></html>`).document;
  const text = articleMarkdown(extracted.body, url);
  if (text.length < 40 || new TextEncoder().encode(text).length > MAX_READING_BYTES - 65536) throw new Error('No usable article text');
  return { markdown: text, title: result.title?.slice(0, 1000) || undefined, author: result.author?.slice(0, 1000) || undefined,
    ...(faviconUrl ? { faviconUrl } : {}) };
}
