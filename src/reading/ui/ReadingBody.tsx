import { readerScrollElement } from './reader-scroll';
import React, { useLayoutEffect, useRef } from 'react';
import type { ReadingHighlight } from '../core/highlights';
import { paintHighlights } from './reader-highlights';

/** Annotation changes must not replace the article's paragraphs or its scroll anchor. */
export function ReadingBody({ body, article, content, highlights }: {
	body: React.RefObject<HTMLDivElement | null>; article: React.RefObject<HTMLElement | null>;
	content: DocumentFragment | null; highlights: ReadingHighlight[];
}) {
	const painted = useRef<{ content: DocumentFragment | null; highlights: string } | null>(null);
	useLayoutEffect(() => {
		const text = body.current, reader = article.current ? readerScrollElement(article.current) : null;
		if (!text) return;
		const signature = JSON.stringify(highlights);
		const previous = painted.current;
		// Saving native highlight markers can produce equivalent sanitized nodes.
		// Keep the existing paragraphs and selection anchors in that case.
		const sameContent = previous && (previous.content === content || (content && previous.content && content.isEqualNode(previous.content)));
		if (sameContent && previous.highlights === signature) return;
		const top = reader?.scrollTop ?? 0, left = reader?.scrollLeft ?? 0;
		// Insert sanitized nodes directly: never serialize and reparse article HTML.
		if (!sameContent) text.replaceChildren(...(content ? [content.cloneNode(true)] : []));
		// Only unwrap our annotations. Captured article <mark> elements remain untouched.
		for (const mark of Array.from(text.querySelectorAll('.crate-reading-reader__highlight'))) mark.replaceWith(...Array.from(mark.childNodes));
		text.normalize();
		paintHighlights(text, highlights);
		painted.current = { content, highlights: signature };
		// Text-node replacement can cause synchronous scroll clamping in browser engines.
		if (reader) { reader.scrollTop = top; reader.scrollLeft = left; }
	}, [article, body, content, highlights]);
	return <div ref={body} className="crate-reading-reader__body" />;
}
