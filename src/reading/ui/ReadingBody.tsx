import { readerScrollElement } from './reader-scroll';
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReadingHighlight } from '../core/highlights';
import { paintHighlights } from './reader-highlights';

/** Annotation changes must not replace the article's paragraphs or its scroll anchor. */
export function ReadingBody({ body, article, html, highlights }: {
	body: React.RefObject<HTMLDivElement | null>; article: React.RefObject<HTMLElement | null>;
	html: string; highlights: ReadingHighlight[];
}) {
	// React compares this object by identity; recreating it rewrites innerHTML.
	const markup = useMemo(() => ({ __html: html }), [html]);
	const painted = useRef<{ html: string; highlights: string } | null>(null);
	useLayoutEffect(() => {
		const text = body.current, reader = article.current ? readerScrollElement(article.current) : null;
		if (!text) return;
		const signature = JSON.stringify(highlights);
		if (painted.current?.html === html && painted.current.highlights === signature) return;
		const top = reader?.scrollTop ?? 0, left = reader?.scrollLeft ?? 0;
		// Only unwrap our annotations. Captured article <mark> elements remain untouched.
		for (const mark of Array.from(text.querySelectorAll('.crate-reading-reader__highlight'))) mark.replaceWith(...Array.from(mark.childNodes));
		text.normalize();
		paintHighlights(text, highlights);
		painted.current = { html, highlights: signature };
		// Text-node replacement can cause synchronous scroll clamping in browser engines.
		if (reader) { reader.scrollTop = top; reader.scrollLeft = left; }
	}, [article, body, html, highlights]);
	return <div ref={body} className="crate-reading-reader__body" dangerouslySetInnerHTML={markup} />;
}
