import type { EditorSelection, EditorState, Line, Text } from '@codemirror/state';
import { readDescriptionBlock } from '../core/reminderDescription';
import { findReminderIdMarker } from '../core/reminderIdentity';

/** A task with text. Only these can gain an ID, so leaving any other line skips reading the whole note. */
export const TASK_WITH_TEXT = /^\s*-\s*\[[ xX]\]\s*\S/;

/** Hidden repeat and completion markers. */
export const RULE_MARKERS_REGEX = /<!-- crate-(?:rule|done):[^>]*? -->/g;
const DESCRIPTION_PREFIX = '<!-- crate-desc:';

/**
 * A line's ID, rule and completion markers, each with the one space it is written after,
 * merged where they touch. Other spaces before a marker stay visible, so a space
 * typed at the end of a reminder shows.
 */
function lineMarkers(text: string): { from: number; to: number }[] {
	const withSpace = (start: number, to: number) => ({ from: start > 0 && /\s/.test(text[start - 1]!) ? start - 1 : start, to });
	const spans = [...text.matchAll(RULE_MARKERS_REGEX)].map(match => withSpace(match.index, match.index + match[0].length));
	const id = findReminderIdMarker(text);
	if (id) spans.push(withSpace(text.indexOf('<!--', id.from), id.to));
	spans.sort((a, b) => a.from - b.from);
	const merged: { from: number; to: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
		else merged.push({ ...span });
	}
	return merged;
}

/** Whether a line holds nothing but a reminder's hidden markers, as when its text and checkbox were deleted. */
export function onlyMarkers(line: Line): boolean {
	const markers = lineMarkers(line.text);
	if (!markers.length) return false;
	let rest = line.text;
	for (const { from, to } of [...markers].reverse()) rest = rest.slice(0, from) + rest.slice(to);
	return !rest.trim();
}

/** Markers that end their line, which is the span the editor hides and keeps edits out of. */
export function endMarker(line: Line): { from: number; to: number } | null {
	const marker = lineMarkers(line.text).pop();
	return marker && line.from + marker.to === line.to ? { from: line.from + marker.from, to: line.to } : null;
}

/**
 * A valid description block under the reminder on `line`, from that line's end
 * to the block's end. Broken blocks stay visible so they can be repaired.
 */
function descriptionBlock(doc: Text, line: Line): { from: number; to: number; description?: string } | null {
	// A reminder whose checkbox is being edited away keeps its ID, and its description stays hidden with it.
	const owner = TASK_WITH_TEXT.test(line.text) || findReminderIdMarker(line.text) !== null;
	if (line.number >= doc.lines || !owner || !doc.line(line.number + 1).text.startsWith(DESCRIPTION_PREFIX)) return null;
	const lines = [line.text];
	for (let number = line.number + 1; number <= doc.lines; number++) {
		const { text } = doc.line(number);
		lines.push(text);
		if (text.includes('-->')) break;
	}
	try {
		const { description, lineCount } = readDescriptionBlock(lines, 0);
		return lineCount ? { from: line.to, to: doc.line(line.number + lineCount).to, description } : null;
	} catch { return null; }
}

/** The hidden end of a reminder: its end markers and the description block under it. */
export function hiddenTail(doc: Text, line: Line): { from: number; to: number; description: boolean } | null {
	const marker = endMarker(line), description = descriptionBlock(doc, line);
	if (!marker && !description) return null;
	return { from: marker?.from ?? line.to, to: description?.to ?? line.to, description: Boolean(description) };
}

const DESCRIPTION_SUFFIX = ' -->';

/**
 * A description block stored as literal text, which the editor can show as text
 * to edit, with the text between its comment markers. Encoded blocks are edited
 * in the reminder editor.
 */
interface EditableDescription {
	reminder: Line;
	from: number;
	to: number;
	textFrom: number;
	textTo: number;
}

export function editableDescription(doc: Text, reminder: Line): EditableDescription | null {
	const block = descriptionBlock(doc, reminder);
	if (!block) return null;
	const first = doc.line(reminder.number + 1);
	if (/^v\d+:/.test(first.text.slice(DESCRIPTION_PREFIX.length).trimStart())) return null;
	return { reminder, from: first.from, to: block.to, textFrom: first.from + DESCRIPTION_PREFIX.length, textTo: block.to - DESCRIPTION_SUFFIX.length };
}

/** The editable description whose comment lines hold `position`. */
export function editableDescriptionAt(doc: Text, position: number): EditableDescription | null {
	const at = doc.lineAt(position).number;
	// Only a block's first line opens its comment; an earlier close ends another block.
	for (let number = at; number > 1 && number > at - 200; number--) {
		const { text } = doc.line(number);
		if (number < at && text.includes('-->')) return null;
		if (text.startsWith(DESCRIPTION_PREFIX)) {
			const description = editableDescription(doc, doc.line(number - 1));
			return description && position <= description.to ? description : null;
		}
		if (text.includes('<!--')) return null;
	}
	return null;
}

/** The reminders whose descriptions show as text: those a selection starts or ends on, or in. */
export function revealedDescriptions(doc: Text, selection: EditorSelection): Set<number> {
	const revealed = new Set<number>();
	for (const range of selection.ranges) {
		for (const position of [range.anchor, range.head]) {
			const line = doc.lineAt(position);
			const description = editableDescriptionAt(doc, position) ?? editableDescription(doc, line);
			if (description) revealed.add(description.reminder.from);
		}
	}
	return revealed;
}

/** The tail of the reminder whose description block ends at `position`, a line end. */
export function tailEndingAt(doc: Text, position: number): { from: number; to: number; description: boolean } | null {
	if (!doc.lineAt(position).text.endsWith(' -->')) return null;
	// Walk up to the block's first line; only that line may open a comment, and an earlier close ends another block.
	for (let number = doc.lineAt(position).number; number > 1; number--) {
		const { text } = doc.line(number);
		if (text.startsWith(DESCRIPTION_PREFIX)) {
			const tail = hiddenTail(doc, doc.line(number - 1));
			return tail?.description && tail.to === position ? tail : null;
		}
		if (text.includes('<!--') || (number < doc.lineAt(position).number && text.includes('-->'))) return null;
	}
	return null;
}

/** Where a line's text starts, after its indentation and any task checkbox. */
export const TEXT_START = /^\s*(?:-\s*\[[ xX]\]\s*)?/;

/** The hidden tail that `position` touches, from its start to its end inclusive. */
function tailAround(doc: Text, position: number): { from: number; to: number; description: boolean } | null {
	const line = doc.lineAt(position);
	// A whole-line range ends at the start of its reminder's description.
	const above = line.number > 1 && line.text.startsWith(DESCRIPTION_PREFIX) ? hiddenTail(doc, doc.line(line.number - 1)) : null;
	const tail = above ?? hiddenTail(doc, line) ?? tailEndingAt(doc, position);
	return tail && tail.from <= position && position <= tail.to ? tail : null;
}

/**
 * Where a copy, cut, delete or drag of `from`..`to` should end so a reminder
 * whose whole text it covers keeps its hidden markers and description, or null
 * when it covers no whole reminder. Ranges that took the reminder's line break
 * also take the one after its description. Only selections and whole lines
 * count: deleting the last character of a short title edits it in place.
 */
export function wholeReminderEnd(doc: Text, from: number, to: number, selected: boolean): number | null {
	const tail = tailAround(doc, to);
	if (!tail) return null;
	const line = doc.lineAt(tail.from), wholeLine = to > line.to;
	if (!(selected || wholeLine) || from > line.from + TEXT_START.exec(line.text)![0].length) return null;
	if (to >= tail.to) return to;
	return wholeLine ? Math.min(tail.to + 1, doc.length) : tail.to;
}

/**
 * The range CodeMirror copies or cuts for a single selection, and the text to
 * copy when that range should carry a reminder's hidden tail, or null to leave
 * the copy to CodeMirror. The cut itself is extended by `protectReminderIdMarker`.
 */
export function reminderClipboard(state: EditorState): { from: number; to: number; text: string } | null {
	if (state.selection.ranges.length > 1) return null;
	const { main } = state.selection, line = state.doc.lineAt(main.head);
	// With nothing selected, CodeMirror copies and cuts the whole line.
	const from = main.empty ? line.from : main.from, to = main.empty ? Math.min(line.to + 1, state.doc.length) : main.to;
	const end = wholeReminderEnd(state.doc, from, to, true);
	return end === null || end === to ? null : { from, to, text: state.sliceDoc(from, end) };
}

/** Ranges of reminder ID and rule markers to hide, including the leading space. */
export function hiddenReminderMarkerRanges(state: EditorState, visible: readonly { from: number; to: number }[]): { from: number; to: number }[] {
	const { doc } = state;
	const ranges: { from: number; to: number }[] = [];
	let last = 0;
	for (const { from, to } of visible) {
		// Adjacent visible ranges can share a line.
		for (let number = Math.max(doc.lineAt(from).number, last + 1); number <= doc.lineAt(to).number; number++) {
			last = number;
			const line = doc.line(number);
			for (const marker of lineMarkers(line.text)) ranges.push({ from: line.from + marker.from, to: line.from + marker.to });
		}
	}
	return ranges;
}

/** Valid description blocks to hide, each from its reminder's line end, with the text they hold. */
export function hiddenDescriptionRanges(doc: Text): { from: number; to: number; description?: string }[] {
	const ranges: { from: number; to: number; description?: string }[] = [];
	for (let number = 2; number <= doc.lines; number++) {
		if (!doc.line(number).text.startsWith(DESCRIPTION_PREFIX)) continue;
		const block = descriptionBlock(doc, doc.line(number - 1));
		if (!block) continue;
		ranges.push(block);
		number = doc.lineAt(block.to).number;
	}
	return ranges;
}

/** Whether a line holds a comment marker besides its reminder's ID and rule markers. */
export function hasCommentMarker(text: string): boolean {
	let rest = text;
	for (const { from, to } of lineMarkers(text).reverse()) rest = rest.slice(0, from) + rest.slice(to);
	return rest.includes('<!--') || rest.includes('-->');
}
