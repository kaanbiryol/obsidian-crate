import type { CapturedArticle } from '../core/article';
import Defuddle from 'defuddle/full';
import { parseHTML } from 'linkedom';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { youtubeVideoId } from '@/reading/core/youtube';
import { articleMarkdown } from './markdown';
import { extractServerRenderedPost, isXPost } from './x-post';
import { discoverFaviconUrl } from './favicon';
import { extractorFetch, type ExtractorTransport } from './defuddle-fetch';
import { expandGistEmbeds } from './gist';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Browsers lowercase HTML attribute names; linkedom keeps them as written. Pages rendered
 * by React write `itemProp` and `srcSet`, which Defuddle's selectors would otherwise miss.
 * SVG and MathML keep their case-sensitive names, such as `viewBox`. */
export function lowercaseHtmlAttributes(document: Document): void {
	for (const element of Array.from(document.querySelectorAll('*'))) {
		if (element.namespaceURI !== HTML_NAMESPACE) continue;
		for (const name of Array.from(element.getAttributeNames())) {
			const lower = name.toLowerCase();
			if (lower === name) continue;
			// As in a browser, the first of two names that differ only in case wins.
			if (!element.hasAttribute(lower)) element.setAttribute(lower, element.getAttribute(name)!);
			element.removeAttribute(name);
		}
	}
}

/** Reading saves no players, so each YouTube player becomes a link to its video: an iframe, or
 * a placeholder a script would replace with one, such as `<div data-src=".../embed/ID">`. */
export function linkYoutubeEmbeds(document: Document, base: string): void {
	for (const element of Array.from(document.querySelectorAll('iframe, [data-src]:not(img)'))) {
		// A player inside one replaced already left the document.
		if (!document.body?.contains(element)) continue;
		let id: string | null;
		try { id = youtubeVideoId(new URL(element.getAttribute('src') || element.getAttribute('data-src') || '', base).href); } catch { continue; }
		if (!id) continue;
		const paragraph = document.createElement('p'), link = document.createElement('a');
		link.setAttribute('href', `https://www.youtube.com/watch?v=${id}`);
		link.textContent = 'Watch on YouTube';
		paragraph.append(link);
		element.replaceWith(paragraph);
	}
}

/** Defuddle's async extractors may reach only allowlisted hosts through
 * `transport`; without one, extraction stays local. Markdown conversion never fetches. */
export async function extractDocument(html: string, url: string, transport?: ExtractorTransport): Promise<CapturedArticle> {
	const document = parseHTML(html).document;
	// linkedom's defaultView proxies globalThis. In Obsidian and the PWA, Defuddle would
	// call the native getComputedStyle on linkedom nodes, throw and return the whole body.
	Object.defineProperty(document, 'defaultView', { value: null });
	lowercaseHtmlAttributes(document);
	linkYoutubeEmbeds(document, url);
	await expandGistEmbeds(document, transport);
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
