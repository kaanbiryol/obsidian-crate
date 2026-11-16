import type { ChangeSpec, Text } from '@codemirror/state';
import { buildDescriptionBlock, readDescriptionBlock } from '../core/reminderDescription';

const SEPARATOR = ' //';
const TASK_PREFIX = /^\s*-\s*\[[ xX]\]\s*/;
/** Inline code, wiki links and Markdown links, whose text may hold ` // ` as text. */
const LITERAL_SPANS = /`[^`]*`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)/g;

/**
 * A description typed on a reminder line after ` //`, ending before the line's
 * hidden markers. `from` is the separator, `start` the description's text and
 * `to` its end; each further ` //` in it, at `breaks`, starts a new line of the
 * description. A separator counts once a space or tab is typed after it, so `//s`
 * and a trailing ` //` stay in the title instead of switching it to a description and
 * back while typing; the text is empty until something is typed after that space.
 * Separators inside inline code or links are text.
 */
export function inlineDescription(text: string): { from: number; start: number; to: number; breaks: number[]; description: string } | null {
	const start = TASK_PREFIX.exec(text)?.[0].length;
	if (start === undefined) return null;
	const end = text.replace(/\r$/, '').length;
	const literal = [...text.matchAll(LITERAL_SPANS)].map(match => [match.index, match.index + match[0].length] as const);
	// An unclosed backtick starts inline code being typed.
	const open = text.split('`').length % 2 === 0 ? text.lastIndexOf('`') : Infinity;
	// The space before the hidden markers belongs to them, not to a separator typed before it.
	const markerAt = text.indexOf('<!--', start);
	const visible = markerAt === -1 ? end : markerAt - (text[markerAt - 1] === ' ' ? 1 : 0);
	const separators: number[] = [];
	for (let from = text.indexOf(SEPARATOR, start); from !== -1; from = text.indexOf(SEPARATOR, from + 1)) {
		const after = from + SEPARATOR.length;
		if (after >= visible || !/\s/.test(text[after]!)) continue;
		if (from > open || literal.some(([spanFrom, spanTo]) => from > spanFrom && from < spanTo)) continue;
		separators.push(from);
	}
	const from = separators[0];
	if (from === undefined || !text.slice(start, from).trim()) return null;
	const to = visible;
	const breaks = separators.slice(1).filter(position => position < to);
	const lines = [...breaks, to].map((lineEnd, index) => text.slice((index ? breaks[index - 1]! : from) + SEPARATOR.length, lineEnd).trim());
	const description = lines.join('\n').replace(/^\n+|\n+$/g, '');
	const first = text.slice(from + SEPARATOR.length, to).search(/\S/);
	return { from, start: first === -1 ? to : from + SEPARATOR.length + first, to, breaks, description };
}

/**
 * Moves each line's inline description into the description block under it,
 * after any description it already has, and drops a separator with nothing
 * after it. Lines whose block cannot be read stay as typed.
 */
export function inlineDescriptionChanges(doc: Text, lineNumbers: Iterable<number>): ChangeSpec[] {
	const lines = doc.toString().split('\n');
	return [...lineNumbers].flatMap(number => {
		const line = doc.line(number), typed = inlineDescription(line.text);
		if (!typed) return [];
		if (!typed.description) return [{ from: line.from + typed.from, to: line.from + typed.to }];
		let existing: { description?: string; lineCount: number };
		try { existing = readDescriptionBlock(lines, number - 1); } catch { return []; }
		const description = existing.description ? `${existing.description}\n${typed.description}` : typed.description;
		const blockEnd = existing.lineCount ? doc.line(number + existing.lineCount).to : line.to;
		return [
			{ from: line.from + typed.from, to: line.from + typed.to },
			{ from: line.to, to: blockEnd, insert: `\n${buildDescriptionBlock(description).join('\n')}` },
		];
	});
}
