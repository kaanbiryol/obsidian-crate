import { readingHighlights, type ReadingHighlight } from './highlights';
import { readingDocument } from './markdown';
import { anchorHighlight, readMarkdownHighlights, writeMarkdownHighlights } from './markdown-highlights';

/** One line written by the Crate Reading Web Clipper template from `{{highlights}}`. */
const CLIPPER_HIGHLIGHTS = /^<!-- crate:clipper-highlights ([^\r\n]*) -->[ \t]*(?:\r?\n|$)/m;

interface ClipperHighlight { text?: unknown; timestamp?: unknown; notes?: unknown }

function occurrences(text: string, excerpt: string): number[] {
	const starts: number[] = [];
	for (let at = text.indexOf(excerpt); at >= 0; at = text.indexOf(excerpt, at + 1)) starts.push(at);
	return starts;
}

/**
 * Moves Web Clipper's highlight export into highlight metadata, keeping its dates and notes.
 * Clipper's inline `==text==` markers settle which repeated passage was meant; other
 * repeated or missing excerpts go to recovery instead of being guessed. Returns null,
 * leaving the note unchanged, when the export is absent, malformed or cannot be applied.
 * Imported IDs are temporary `clipper-` values for the caller to replace.
 */
export function importClipperHighlights(body: string): { body: string; highlights: ReadingHighlight[]; recovery: ReadingHighlight[] } | null {
	const match = CLIPPER_HIGHLIGHTS.exec(body);
	if (!match) return null;
	const rest = body.slice(0, match.index) + body.slice(match.index + match[0].length);
	// Clipper leaves the variable empty when the page has no highlights.
	if (!match[1]!.trim()) return { body: rest, highlights: [], recovery: [] };
	try {
		const entries: unknown = JSON.parse(match[1]!);
		if (!Array.isArray(entries)) return null;
		const { text } = readingDocument(rest), marks = readMarkdownHighlights(rest).highlights;
		const imported: ReadingHighlight[] = [], recovery: ReadingHighlight[] = [];
		(entries as ClipperHighlight[]).forEach((entry, index) => {
			if (!entry || typeof entry.text !== 'string') return;
			const createdAt = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toISOString() : undefined;
			const notes = Array.isArray(entry.notes) ? entry.notes.filter((note): note is string => typeof note === 'string' && !!note.trim()) : [];
			// Clipper joins a selection that crosses blocks with blank lines.
			entry.text.split(/\n{2,}/).forEach((part, partIndex) => {
				const excerpt = readingDocument(part).text.trim();
				if (!excerpt) return;
				const details = { id: `clipper-${index}-${partIndex}`, ...(createdAt ? { createdAt } : {}),
					...(partIndex === 0 && notes.length ? { note: notes.join('\n\n') } : {}) };
				const starts = occurrences(text, excerpt);
				const marked = marks.filter(mark => mark.id?.startsWith('markdown-') && starts.some(start => mark.start <= start && start + excerpt.length <= mark.end));
				if (marked.length === 1) Object.assign(marked[0]!, details);
				else if (!marked.length && starts.length === 1 && ![...marks, ...imported].some(other => other.start < starts[0]! + excerpt.length && starts[0]! < other.end)) {
					imported.push(anchorHighlight(text, { start: starts[0]!, end: starts[0]! + excerpt.length, text: excerpt, ...details }));
				} else recovery.push({ start: 0, end: excerpt.length, text: excerpt, ...details });
			});
		});
		// Rewriting re-places every delimiter, so keep Clipper's markers when none are added.
		const written = imported.length ? writeMarkdownHighlights(rest, [...marks, ...imported]) : { markdown: rest, highlights: readingHighlights(marks) };
		// Unclaimed markers stay in the body for the regular Reading scan to record.
		return { body: written.markdown, highlights: written.highlights.filter(highlight => !highlight.id?.startsWith('markdown-')), recovery: readingHighlights(recovery) };
	} catch {
		return null;
	}
}
