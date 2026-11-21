/** Offsets refer to the sanitized reader's textContent, not Markdown bytes. An image highlight
 * has `image`, the image's source as the note links it, sits at the text offset where the image
 * appears (`start` equals `end`), and keeps the image's alt text as `text`. */
export interface ReadingHighlight {
	start: number; end: number; text: string;
	image?: string;
	id?: string; createdAt?: string; prefix?: string; suffix?: string; note?: string;
	/** Exact code selections that cannot contain Markdown highlight delimiters. */
	codeAnchor?: true;
	/** Exact visible text whose source cannot safely contain highlight delimiters. */
	textAnchor?: true;
}

export function readingHighlights(value: unknown): ReadingHighlight[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error('Use up to 100 highlights per article.');
	let length = 0;
	for (const entry of value as unknown[]) {
		if (!entry || typeof entry !== 'object') throw new Error('Invalid article highlight.');
		const { start, end, text, image } = entry as ReadingHighlight;
		if (image !== undefined) {
			if (typeof image !== 'string' || !image || image.length > 2048 || !Number.isSafeInteger(start) || start < 0 || start > 1024 * 1024 || end !== start
				|| typeof text !== 'string' || text.length > 1000 || (entry as ReadingHighlight).codeAnchor || (entry as ReadingHighlight).textAnchor) throw new Error('Invalid image highlight.');
		} else if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 1024 * 1024
			|| typeof text !== 'string' || !text.trim() || text.length !== end - start || text.length > 4000) throw new Error('Select between 1 and 4,000 characters to highlight.');
		if (image === undefined) length += text.length;
		const value = entry as ReadingHighlight;
		if (value.codeAnchor !== undefined && value.codeAnchor !== true) throw new Error('Invalid code highlight.');
		if (value.textAnchor !== undefined && value.textAnchor !== true) throw new Error('Invalid text highlight.');
		for (const [key, limit] of [['id', 100], ['createdAt', 40], ['prefix', 64], ['suffix', 64], ['note', 4000]] as const) {
			if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > limit)) throw new Error('Invalid highlight metadata.');
		}
		if (value.createdAt && !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid highlight date.');
	}
	if (length > 16000) throw new Error('This article has too much highlighted text. Remove a highlight first.');
	if (new TextEncoder().encode(JSON.stringify(value)).length > 48 * 1024) throw new Error('This article has too many highlight notes. Shorten a note before saving.');
	return (value as ReadingHighlight[]).map(({ start, end, text, image, id, createdAt, prefix, suffix, note, codeAnchor, textAnchor }) => ({ start, end, text,
		...(image === undefined ? {} : { image }),
		...(id === undefined ? {} : { id }), ...(createdAt === undefined ? {} : { createdAt }),
		...(prefix === undefined ? {} : { prefix }), ...(suffix === undefined ? {} : { suffix }), ...(note === undefined ? {} : { note }),
		...(codeAnchor ? { codeAnchor } : {}),
		...(textAnchor ? { textAnchor } : {}),
	}));
}

/** Text highlights whose passage still reads the same; image highlights are matched by their image. */
export function matchingHighlights(text: string, highlights: ReadingHighlight[]): ReadingHighlight[] {
	// Never silently attach a saved annotation to different text after a note edit.
	return highlights.filter(highlight => highlight.image === undefined && text.slice(highlight.start, highlight.end) === highlight.text);
}

/** What a highlight shows as its excerpt: its text, or an image's alt text. */
export function highlightExcerpt(highlight: ReadingHighlight): string {
	return highlight.image !== undefined ? highlight.text || 'Image' : highlight.text;
}

/** The same highlight: an image at the same place, or a passage with the same bounds. */
export function sameHighlight(a: ReadingHighlight, b: ReadingHighlight): boolean {
	return a.image !== undefined || b.image !== undefined ? a.image === b.image && a.start === b.start : a.start === b.start && a.end === b.end;
}
