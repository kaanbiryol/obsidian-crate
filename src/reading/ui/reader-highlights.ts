import { getEditorSelectionRange } from '../../ui/shared/editor-selection';
import { matchingHighlights, sameHighlight, type ReadingHighlight } from '../core/highlights';
import { READING_IMAGE_SOURCE_ATTRIBUTE } from './reading-content';

const IMAGE_HIGHLIGHT_CLASS = 'crate-reading-reader__image-highlight';

/** Each image the reader shows, at the text offset where it appears. */
function readerImages(body: HTMLElement): { element: HTMLImageElement; offset: number; source: string }[] {
	const walker = body.ownerDocument.createTreeWalker(body, 1 /* SHOW_ELEMENT */ | 4 /* SHOW_TEXT */);
	const images: { element: HTMLImageElement; offset: number; source: string }[] = [];
	let offset = 0;
	while (walker.nextNode()) {
		const node = walker.currentNode;
		if (node.nodeType === 3) offset += (node as Text).length;
		else if ((node as Element).localName === 'img') {
			const source = (node as Element).getAttribute(READING_IMAGE_SOURCE_ATTRIBUTE);
			if (source) images.push({ element: node as HTMLImageElement, offset, source });
		}
	}
	return images;
}

/** The highlight a tap on `image` makes. */
export function imageHighlightOf(body: HTMLElement, image: HTMLImageElement): ReadingHighlight | null {
	const entry = readerImages(body).find(candidate => candidate.element === image);
	return entry ? { start: entry.offset, end: entry.offset, text: image.alt.slice(0, 1000), image: entry.source } : null;
}

/** The reader's image an image highlight names. */
export function highlightImage(body: HTMLElement, highlight: ReadingHighlight): HTMLImageElement | null {
	if (highlight.image === undefined) return null;
	return readerImages(body).find(entry => entry.offset === highlight.start && entry.source === highlight.image)?.element ?? null;
}

/** Removes the marks `paintHighlights` put on images. */
export function clearImageHighlights(body: HTMLElement): void {
	for (const image of Array.from(body.querySelectorAll<HTMLElement>(`.${IMAGE_HIGHLIGHT_CLASS}`))) {
		image.classList.remove(IMAGE_HIGHLIGHT_CLASS);
		for (const name of ['role', 'aria-label', 'tabindex', 'data-highlight-start', 'data-highlight-end', 'data-sync']) image.removeAttribute(name);
	}
}

function paintImageHighlights(body: HTMLElement, highlights: ReadingHighlight[], pending: ReadingHighlight[]): void {
	const images = highlights.filter(highlight => highlight.image !== undefined);
	if (!images.length) return;
	for (const { element, offset, source } of readerImages(body)) {
		const highlight = images.find(entry => entry.start === offset && entry.image === source);
		if (!highlight) continue;
		element.classList.add(IMAGE_HIGHLIGHT_CLASS);
		element.dataset.highlightStart = String(offset); element.dataset.highlightEnd = String(offset);
		if (pending.some(entry => sameHighlight(entry, highlight))) element.dataset.sync = 'pending';
		element.setAttribute('role', 'button'); element.setAttribute('aria-label', 'Image highlight options');
		element.tabIndex = 0;
	}
}

export function selectedHighlight(body: HTMLElement): ReadingHighlight | null {
	const range = getEditorSelectionRange(body);
	if (!range || range.collapsed) return null;
	if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
	const prefix = range.cloneRange();
	prefix.selectNodeContents(body); prefix.setEnd(range.startContainer, range.startOffset);
	const start = prefix.toString().length, text = range.toString();
	return text.trim() ? { start, end: start + text.length, text } : null;
}

/** Split only text nodes: links, emphasis and paragraph structure remain intact.
 * A painted passage is pending while any highlight it covers is still unsynced. */
export function paintHighlights(body: HTMLElement, highlights: ReadingHighlight[], pending: ReadingHighlight[] = []): void {
	if (!highlights.length) return;
	paintImageHighlights(body, highlights, pending);
	const ranges = matchingHighlights(body.textContent ?? '', highlights).sort((a, b) => a.start - b.start);
	const isPending = (range: ReadingHighlight) => pending.some(entry => entry.start === range.start && entry.end === range.end);
	const merged: Array<{ start: number; end: number; pending: boolean }> = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range.start < last.end) { last.end = Math.max(last.end, range.end); last.pending ||= isPending(range); }
		else merged.push({ start: range.start, end: range.end, pending: isPending(range) });
	}
	const walker = body.ownerDocument.createTreeWalker(body, 4 /* SHOW_TEXT */);
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	let offset = 0;
	for (const node of nodes) {
		const text = node.data, end = offset + text.length;
		const spans = merged.filter(range => range.start < end && range.end > offset);
		if (spans.length) {
			const fragment = body.ownerDocument.createDocumentFragment();
			let cursor = 0;
			for (const span of spans) {
				const from = Math.max(0, span.start - offset), to = Math.min(text.length, span.end - offset);
				fragment.append(text.slice(cursor, from));
				const mark = body.ownerDocument.createElement('mark');
				mark.className = 'crate-reading-reader__highlight'; mark.textContent = text.slice(from, to);
				mark.dataset.highlightStart = String(span.start); mark.dataset.highlightEnd = String(span.end);
				if (span.pending) mark.dataset.sync = 'pending';
				mark.setAttribute('role', 'button'); mark.setAttribute('aria-label', 'Highlight options');
				mark.tabIndex = span.start >= offset ? 0 : -1;
				fragment.append(mark); cursor = to;
			}
			fragment.append(text.slice(cursor)); node.replaceWith(fragment);
		}
		offset = end;
	}
}

/** Resolve portable text offsets after markup is repainted or split into marks. */
export function highlightRange(body: HTMLElement, highlight: ReadingHighlight): Range | null {
	if (highlight.image !== undefined) {
		const image = highlightImage(body, highlight);
		if (!image) return null;
		const range = body.ownerDocument.createRange();
		range.selectNode(image);
		return range;
	}
	if ((body.textContent ?? '').slice(highlight.start, highlight.end) !== highlight.text) return null;
	const walker = body.ownerDocument.createTreeWalker(body, 4);
	const range = body.ownerDocument.createRange();
	let offset = 0, started = false;
	while (walker.nextNode()) {
		const node = walker.currentNode as Text, end = offset + node.length;
		if (!started && highlight.start < end) { range.setStart(node, highlight.start - offset); started = true; }
		if (started && highlight.end <= end) { range.setEnd(node, highlight.end - offset); return range; }
		offset = end;
	}
	return null;
}

export function highlightOffsetAtPoint(body: HTMLElement, x: number, y: number): number | null {
	const document = body.ownerDocument;
	const root = body.getRootNode();
	const caret = document.caretPositionFromPoint?.(x, y, root.nodeType === 11 ? { shadowRoots: [root as ShadowRoot] } : undefined);
	const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
	const node = caret?.offsetNode ?? fallback?.startContainer, offset = caret?.offset ?? fallback?.startOffset;
	if (!node || offset === undefined || !body.contains(node)) return null;
	const prefix = document.createRange(); prefix.selectNodeContents(body); prefix.setEnd(node, offset);
	return prefix.toString().length;
}

export function resizeHighlight(text: string, highlight: ReadingHighlight, edge: 'start' | 'end', offset: number): ReadingHighlight {
	const minimum = edge === 'start' ? 0 : highlight.start + 1;
	const maximum = edge === 'start' ? highlight.end - 1 : text.length;
	offset = Math.max(minimum, Math.min(offset, maximum));
	// Avoid splitting a UTF-16 surrogate pair while adjusting with the keyboard.
	if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) offset += edge === 'start' ? -1 : 1;
	const start = edge === 'start' ? offset : highlight.start;
	const end = edge === 'end' ? offset : highlight.end;
	return { start, end, text: text.slice(start, end) };
}

/** Text-only rectangles avoid painting the empty width of fully selected blocks. */
export function highlightTextRects(body: HTMLElement, highlight: ReadingHighlight): DOMRect[] {
	if (highlight.image !== undefined) {
		const rect = highlightImage(body, highlight)?.getBoundingClientRect();
		return rect && rect.width > 0 && rect.height > 0 ? [rect] : [];
	}
	const walker = body.ownerDocument.createTreeWalker(body, 4), rects: DOMRect[] = [];
	let offset = 0;
	while (walker.nextNode()) {
		const node = walker.currentNode as Text, end = offset + node.length;
		if (end > highlight.start && offset < highlight.end) {
			const range = body.ownerDocument.createRange();
			range.setStart(node, Math.max(0, highlight.start - offset));
			range.setEnd(node, Math.min(node.length, highlight.end - offset));
			rects.push(...Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0));
		}
		if (end >= highlight.end) break;
		offset = end;
	}
	return rects;
}
