/** Offsets refer to the sanitized reader's textContent, not Markdown bytes. */
export interface ReadingHighlight { start: number; end: number; text: string }

export function readingHighlights(value: unknown): ReadingHighlight[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error('Use up to 100 highlights per article.');
	let length = 0;
	for (const entry of value as unknown[]) {
		if (!entry || typeof entry !== 'object') throw new Error('Invalid article highlight.');
		const { start, end, text } = entry as ReadingHighlight;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 1024 * 1024
			|| typeof text !== 'string' || !text.trim() || text.length !== end - start || text.length > 4000) throw new Error('Select between 1 and 4,000 characters to highlight.');
		length += text.length;
	}
	if (length > 16000) throw new Error('This article has too much highlighted text. Remove a highlight first.');
	return (value as ReadingHighlight[]).map(({ start, end, text }) => ({ start, end, text }));
}

export function matchingHighlights(text: string, highlights: ReadingHighlight[]): ReadingHighlight[] {
	// Never silently attach a saved annotation to different text after a note edit.
	return highlights.filter(highlight => text.slice(highlight.start, highlight.end) === highlight.text);
}
