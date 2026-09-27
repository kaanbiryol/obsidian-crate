/** Offsets refer to the sanitized reader's textContent, not Markdown bytes. */
export interface ReadingHighlight {
	start: number; end: number; text: string;
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
		const { start, end, text } = entry as ReadingHighlight;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 1024 * 1024
			|| typeof text !== 'string' || !text.trim() || text.length !== end - start || text.length > 4000) throw new Error('Select between 1 and 4,000 characters to highlight.');
		length += text.length;
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
	return (value as ReadingHighlight[]).map(({ start, end, text, id, createdAt, prefix, suffix, note, codeAnchor, textAnchor }) => ({ start, end, text,
		...(id === undefined ? {} : { id }), ...(createdAt === undefined ? {} : { createdAt }),
		...(prefix === undefined ? {} : { prefix }), ...(suffix === undefined ? {} : { suffix }), ...(note === undefined ? {} : { note }),
		...(codeAnchor ? { codeAnchor } : {}),
		...(textAnchor ? { textAnchor } : {}),
	}));
}

export function matchingHighlights(text: string, highlights: ReadingHighlight[]): ReadingHighlight[] {
	// Never silently attach a saved annotation to different text after a note edit.
	return highlights.filter(highlight => text.slice(highlight.start, highlight.end) === highlight.text);
}
