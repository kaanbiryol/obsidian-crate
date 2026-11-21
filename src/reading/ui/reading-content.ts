import DOMPurify from 'dompurify';
import { readingMarkdown } from '../core/markdown';
import { READING_DROP_CONTENTS, READING_HTML_TAGS } from '../core/html-policy';
import { readingImageSource } from '../core/article-images';

/** Set on an image saved in the vault; the host loads it, since each host reads vault files differently. */
export const READING_IMAGE_PATH_ATTRIBUTE = 'data-crate-image-path';

/** The image's `src` as the note links it, which an image highlight names. */
export const READING_IMAGE_SOURCE_ATTRIBUTE = 'data-crate-image-source';

/** Which images an article shows: vault copies relative to `notePath`, and web images only with `remote`. */
export interface ReadingContentImages { notePath: string; remote: boolean }

/** All article HTML is untrusted, including content captured by Web Clipper. Without `images`
 * the article shows no images and loads nothing. */
export function renderReadingContent(markdown: string, source: string, highlightCode?: (code: string, language: string) => string | undefined, images?: ReadingContentImages): DocumentFragment {
	const html = readingMarkdown.parse(markdown, { async: false });
	const container = DOMPurify.sanitize(html, {
		// Parse an article fragment: document parsing drops whitespace after an
		// opening comment (including Crate's article marker), shifting offsets.
		RETURN_DOM_FRAGMENT: true, FORCE_BODY: true,
		ADD_ATTR: (attribute, tag) => Boolean(highlightCode) && tag === 'code' && attribute === 'class',
		ALLOWED_TAGS: READING_HTML_TAGS, FORBID_CONTENTS: READING_DROP_CONTENTS,
		ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'data-crate-native', 'src', 'alt'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
	});
	// Metadata paints the current (including offline pending) set. Native markers
	// are already represented in that set and must also be removable optimistically.
	for (const mark of Array.from(container.querySelectorAll('mark[data-crate-native]'))) mark.replaceWith(...Array.from(mark.childNodes));
	for (const link of Array.from(container.querySelectorAll('a'))) {
		const unlink = () => link.replaceWith(...Array.from(link.childNodes));
		try {
			const href = link.getAttribute('href');
			if (!href) { unlink(); continue; }
			const url = new URL(href, source || undefined);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { unlink(); continue; }
			link.setAttribute('href', url.href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
		} catch { unlink(); }
	}
	for (const image of Array.from(container.querySelectorAll('img'))) {
		const source = image.getAttribute('src') ?? '';
		const target = images ? readingImageSource(source, images.notePath) : null;
		image.removeAttribute('src');
		if (!target || target.kind === 'remote' && !images?.remote) { image.remove(); continue; }
		image.setAttribute(READING_IMAGE_SOURCE_ATTRIBUTE, source);
		image.setAttribute('loading', 'lazy'); image.setAttribute('decoding', 'async');
		if (target.kind === 'vault') { image.setAttribute(READING_IMAGE_PATH_ATTRIBUTE, target.path); continue; }
		// The website sees the request, but not which page or vault it came from.
		image.setAttribute('referrerpolicy', 'no-referrer');
		image.setAttribute('src', target.url);
	}
	let remainingCode = 100_000;
	for (const code of Array.from(container.querySelectorAll('code'))) {
		const language = /(?:^|\s)language-([\w+#-]+)/i.exec(code.className)?.[1]?.toLowerCase() ?? '';
		code.removeAttribute('class');
		const text = code.textContent ?? '';
		if (!highlightCode || code.parentElement?.tagName !== 'PRE' || text.length > remainingCode) continue;
		remainingCode -= text.length;
		const highlighted = highlightCode(text, language);
		if (highlighted !== undefined) {
			const tokens = DOMPurify.sanitize(highlighted, { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
			if (tokens.textContent === text) code.replaceChildren(tokens);
		}
	}
	// Unwrapped markers must compare equal to the same unannotated article.
	container.normalize();
	return container;
}
