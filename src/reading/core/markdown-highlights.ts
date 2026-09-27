import { readingHighlights, type ReadingHighlight } from './highlights';
import { readingDocument, type MarkdownDocument } from './markdown';

function anchored(text: string, highlight: ReadingHighlight): ReadingHighlight | null {
	const matches: number[] = [];
	let at = text.indexOf(highlight.text);
	while (at >= 0) { matches.push(at); at = text.indexOf(highlight.text, at + 1); }
	const contextual = matches.filter(start => (highlight.prefix === undefined || text.slice(Math.max(0, start - highlight.prefix.length), start) === highlight.prefix)
		&& (highlight.suffix === undefined || text.slice(start + highlight.text.length, start + highlight.text.length + highlight.suffix.length) === highlight.suffix));
	const start = contextual.length === 1 ? contextual[0] : highlight.prefix === undefined && matches.includes(highlight.start) ? highlight.start : matches.length === 1 ? matches[0] : undefined;
	return start === undefined ? null : { ...highlight, start, end: start + highlight.text.length };
}

export function anchorHighlight(text: string, highlight: ReadingHighlight): ReadingHighlight {
	return { ...highlight, prefix: text.slice(Math.max(0, highlight.start - 32), highlight.start), suffix: text.slice(highlight.end, highlight.end + 32) };
}

function covered(document: MarkdownDocument, highlight: ReadingHighlight): boolean {
	if (highlight.textAnchor) return true;
	for (let i = highlight.start; i < highlight.end; i++) {
		if (!/\s/.test(document.text[i]!) && !document.marks.some(mark => mark.start <= i && i < mark.end)
			&& !(highlight.codeAnchor && document.codes.some(code => code.start <= i && i < code.end))) return false;
	}
	return true;
}

function samePassage(document: MarkdownDocument, highlight: ReadingHighlight): boolean {
	// Moving a delimiter in Obsidian changes the passage, even when the old
	// selection is still contained within the newly highlighted text.
	return covered(document, highlight) && document.marks.every(mark => mark.end <= highlight.start || mark.start >= highlight.end
		|| !document.text.slice(mark.start, highlight.start).trim() && !document.text.slice(highlight.end, mark.end).trim());
}

/** Inline markers own prose; explicit anchors preserve source-sensitive excerpts. */
export function readMarkdownHighlights(markdown: string, stored: ReadingHighlight[] = [], legacy = false) {
	const document = readingDocument(markdown), highlights: ReadingHighlight[] = [], recovery: ReadingHighlight[] = [];
	for (const entry of stored) {
		const match = anchored(document.text, entry);
		if (match && (legacy || samePassage(document, match))) highlights.push(anchorHighlight(document.text, match));
		else if (legacy || entry.note || entry.codeAnchor || entry.textAnchor) recovery.push(entry);
	}
	if (!legacy) {
		// After deleting a repeated passage, several old annotations can resolve
		// to the same remaining marker. Preserve them without guessing ownership.
		const ambiguous = new Set(highlights.filter((entry, index) => highlights.some((other, otherIndex) => otherIndex !== index
			&& other.start < entry.end && entry.start < other.end)));
		recovery.push(...[...ambiguous].filter(entry => entry.note || entry.codeAnchor || entry.textAnchor));
		for (let i = highlights.length - 1; i >= 0; i--) if (ambiguous.has(highlights[i]!)) highlights.splice(i, 1);
	}
	for (const mark of document.marks) {
		if (highlights.some(entry => entry.start <= mark.start && entry.end >= mark.end)) continue;
		const text = document.text.slice(mark.start, mark.end);
		if (!text.trim()) continue;
		let id = `markdown-${mark.open}`;
		while (highlights.some(entry => entry.id === id)) id += '-new';
		highlights.push(anchorHighlight(document.text, { start: mark.start, end: mark.end, text, id }));
	}
	highlights.sort((a, b) => a.start - b.start);
	for (let i = 1; i < highlights.length;) {
		const previous = highlights[i - 1]!, current = highlights[i]!;
		if (current.start >= previous.end) { i++; continue; }
		const end = Math.max(previous.end, current.end);
		if (legacy && end - previous.start <= 4000 && !current.note && !previous.note) {
			highlights[i - 1] = anchorHighlight(document.text, { ...previous, end, text: document.text.slice(previous.start, end) });
		} else if (legacy || current.note || current.codeAnchor || current.textAnchor) recovery.push(current);
		highlights.splice(i, 1);
	}
	return { highlights: readingHighlights(highlights), recovery };
}

interface HighlightPlan {
	highlight: ReadingHighlight;
	spans: { start: number; end: number; leaf: number }[];
}

function textAnchored(plan: HighlightPlan): HighlightPlan {
	const highlight = { ...plan.highlight, textAnchor: true as const };
	delete highlight.codeAnchor;
	return { highlight, spans: [] };
}

function insertMarkers(markdown: string, plans: HighlightPlan[]): string {
	const insertions = new Map<number, string>();
	for (const { spans } of plans) for (const span of spans) {
		insertions.set(span.start, `${insertions.get(span.start) ?? ''}==`);
		insertions.set(span.end, `==${insertions.get(span.end) ?? ''}`);
	}
	for (const [offset, text] of [...insertions].sort(([a], [b]) => b - a)) markdown = markdown.slice(0, offset) + text + markdown.slice(offset);
	return markdown;
}

/** Prefer native markers, but never change link targets or the rendered structure. */
function resolvePlans(plain: string, document: MarkdownDocument, plans: HighlightPlan[]) {
	let checks = 0;
	const valid = (group: HighlightPlan[]) => {
		if (checks++ >= 16) return false;
		const markdown = insertMarkers(plain, group);
		const updated = markdown === plain ? document : readingDocument(markdown);
		return updated.text === document.text && updated.html === document.html && group.every(plan => samePassage(updated, plan.highlight));
	};
	const resolve = (group: HighlightPlan[]): HighlightPlan[] => {
		if (valid(group)) return group;
		// Most saves use one check. Bound expensive retries for large articles
		// while keeping all selected excerpts through the annotation fallback.
		if (group.length <= 1 || checks >= 16) return group.map(textAnchored);
		const middle = Math.floor(group.length / 2);
		const combined = [...resolve(group.slice(0, middle)), ...resolve(group.slice(middle))];
		return valid(combined) ? combined : combined.map(textAnchored);
	};
	const resolved = resolve(plans);
	return { markdown: insertMarkers(plain, resolved), highlights: readingHighlights(resolved.map(plan => plan.highlight)) };
}

/** Change delimiter bytes only; otherwise store a contextual text annotation. */
export function writeMarkdownHighlights(markdown: string, value: ReadingHighlight[]): { markdown: string; highlights: ReadingHighlight[] } {
	const desired = readingHighlights(value), original = readingDocument(markdown);
	const delimiters = [...new Set(original.marks.flatMap(mark => [mark.open, mark.close]))].sort((a, b) => b - a);
	let plain = markdown;
	for (const offset of delimiters) plain = plain.slice(0, offset) + plain.slice(offset + 2);
	const document = readingDocument(plain);
	if (document.text !== original.text || document.html !== original.html) throw new Error('This Markdown cannot be highlighted safely. Edit its highlights in Obsidian.');
	const plans: HighlightPlan[] = [];
	let previousEnd = -1;
	for (const entry of [...desired].sort((a, b) => a.start - b.start)) {
		if (document.text.slice(entry.start, entry.end) !== entry.text) throw new Error('Article text changed. Reopen it before highlighting.');
		if (/[\uDC00-\uDFFF]/.test(entry.text[0]!) || /[\uD800-\uDBFF]/.test(entry.text.at(-1)!)) throw new Error('Select the whole character to highlight.');
		for (const boundary of [entry.start, entry.end]) {
			const before = document.characters[boundary - 1], after = document.characters[boundary];
			if (before && after && before.start === after.start && before.end === after.end) throw new Error('Select the whole character to highlight.');
		}
		if (entry.prefix !== undefined && entry.prefix !== document.text.slice(Math.max(0, entry.start - entry.prefix.length), entry.start)
			|| entry.suffix !== undefined && entry.suffix !== document.text.slice(entry.end, entry.end + entry.suffix.length)) throw new Error('Article text changed. Reopen it before highlighting.');
		if (entry.start < previousEnd) throw new Error('This selection overlaps another highlight. Adjust the existing highlight instead.');
		previousEnd = entry.end;
		const spans: { start: number; end: number; leaf: number }[] = [];
		let codeAnchor = false, textAnchor = false;
		const addSpan = (span: { start: number; end: number; leaf: number }) => {
			const last = spans.at(-1), between = last ? plain.slice(last.end, span.start) : '';
			if (last && (last.leaf === span.leaf || !between.trim()) && !/[\r\n]/.test(between)) last.end = span.end;
			else spans.push({ ...span });
		};
		for (let i = entry.start; i < entry.end; i++) {
			const linkIndex = document.autolinks.findIndex(link => link.start <= i && i < link.end), link = document.autolinks[linkIndex];
			if (link) {
				if (link.source && entry.start <= link.start && entry.end >= link.end) addSpan({ ...link.source, leaf: -document.codes.length - linkIndex - 1 });
				else textAnchor = true;
				i = Math.min(entry.end, link.end) - 1;
				continue;
			}
			const character = document.characters[i];
			if (!character) {
				const codeIndex = document.codes.findIndex(code => code.start <= i && i < code.end), code = document.codes[codeIndex];
				if (code) {
					const source = code.source, raw = source && plain.slice(source.start, source.end);
					if (source && entry.start <= code.start && entry.end >= code.end && !/[\r\n]|==/.test(raw!)) addSpan({ ...source, leaf: -codeIndex - 1 });
					else codeAnchor = true;
					i = Math.min(entry.end, code.end) - 1;
					continue;
				}
				if (!/\s/.test(document.text[i]!)) textAnchor = true;
				continue;
			}
			if (/\s/.test(document.text[i]!)) continue;
			addSpan(character);
		}
		if (!spans.length && !codeAnchor && !textAnchor) throw new Error('Select some article text to highlight.');
		const highlight = anchorHighlight(document.text, { ...entry, id: entry.id ?? crypto.randomUUID(), createdAt: entry.createdAt ?? new Date().toISOString() });
		delete highlight.textAnchor;
		if (codeAnchor) highlight.codeAnchor = true; else delete highlight.codeAnchor;
		const plan = { highlight, spans };
		plans.push(textAnchor ? textAnchored(plan) : plan);
	}
	return resolvePlans(plain, document, plans);
}
