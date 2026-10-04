import { Parser } from 'htmlparser2';
import { readingDocument } from './markdown';
import { READING_DROP_CONTENTS, READING_HTML_TAGS } from './html-policy';

export interface TranscriptSegment { seconds: number; label: string; start: number; end: number }

export function timestampSeconds(value: string): number | null {
	if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(value)) return null;
	const parts = value.split(':').map(Number);
	if (parts.slice(1).some(part => part >= 60)) return null;
	return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

export function timestampLabel(seconds: number): string {
	const value = Math.floor(seconds), minutes = Math.floor(value / 60);
	return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : minutes}:${String(value % 60).padStart(2, '0')}`;
}

/** Clipper/Defuddle's timestamp paragraphs stay ordinary Markdown. Offsets use
 * the same visible text as highlights; player controls never enter this text. */
export function transcriptSegments(markdown: string): TranscriptSegment[] {
	const document = readingDocument(markdown), segments: TranscriptSegment[] = [];
	let offset = 0, hidden = 0;
	const stack: { name: string; start: number; hidden: boolean }[] = [];
	new Parser({
		onopentag(name) {
			const drop = READING_DROP_CONTENTS.includes(name) && !READING_HTML_TAGS.includes(name);
			if (drop) hidden++;
			stack.push({ name, start: offset, hidden: drop });
		},
		ontext(text) { if (!hidden) offset += text.length; },
		onclosetag() {
			const entry = stack.pop();
			if (!entry) return;
			if (entry.hidden) hidden--;
			if (hidden || !['p', 'li'].includes(entry.name)) return;
			const text = document.text.slice(entry.start, offset);
			const match = /^\s*(\d{1,3}:\d{2}(?::\d{2})?)\s*(?:[·—–-]\s*|\s+)(\S[\s\S]*)$/.exec(text);
			const seconds = match ? timestampSeconds(match[1]!) : null;
			if (seconds !== null && match) segments.push({ seconds, label: match[1]!, start: entry.start, end: offset });
		},
	}).end(document.html);
	// Malformed/reordered timestamps must not attach a highlight to the wrong moment.
	const ordered = segments.sort((a, b) => a.start - b.start);
	return ordered.some((segment, index) => index > 0 && segment.seconds < ordered[index - 1]!.seconds) ? [] : ordered;
}

export function transcriptMoment(segments: TranscriptSegment[], start: number, end: number): number | undefined {
	return segments.find(segment => start < segment.end && end > segment.start)?.seconds;
}
