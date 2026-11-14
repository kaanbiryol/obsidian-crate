import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { inlineDescription, inlineDescriptionChanges } from './inline-description';

function moved(doc: string, lines: number[]) {
	const state = EditorState.create({ doc });
	return state.update({ changes: inlineDescriptionChanges(state.doc, lines) }).state.doc.toString();
}

describe('inline reminder descriptions', () => {
	it('reads the text after the separator, before hidden markers', () => {
		const text = '- [ ] Call Mia // bring the receipts <!-- crate-id:a -->';
		const found = inlineDescription(text)!;
		expect(found.description).toBe('bring the receipts');
		expect(text.slice(found.from, found.to)).toBe(' // bring the receipts');
	});

	it('ignores separators in inline code, without a title or without a description', () => {
		expect(inlineDescription('- [ ] Fix `a // b` parsing')).toBeNull();
		expect(inlineDescription('- [ ] Fix `a // b` // later')?.description).toBe('later');
		expect(inlineDescription('- [ ]  // only a note')).toBeNull();
		expect(inlineDescription('- [ ] Call Mia //b')).toBeNull();
		expect(inlineDescription('- [ ] Call Mia /// b')).toBeNull();
		expect(inlineDescription('- [ ] Read https://example.com/a')).toBeNull();
		expect(inlineDescription('Plain // text')).toBeNull();
	});

	it('starts a description at a separator with nothing typed after it yet', () => {
		expect(inlineDescription('- [ ] Call Mia //')).toEqual({ from: 14, start: 17, to: 17, breaks: [], description: '' });
		expect(inlineDescription('- [ ] Call Mia // <!-- crate-id:a -->')).toEqual({ from: 14, start: 17, to: 17, breaks: [], description: '' });
		// Leaving a separator with nothing after it drops it.
		expect(moved('- [ ] Call Mia // <!-- crate-id:a -->\nNext', [1])).toBe('- [ ] Call Mia <!-- crate-id:a -->\nNext');
	});

	it('moves the description under the reminder, after its hidden markers', () => {
		expect(moved('- [ ] Call Mia // bring receipts <!-- crate-id:a -->\nNext', [1]))
			.toBe('- [ ] Call Mia <!-- crate-id:a -->\n<!-- crate-desc:bring receipts -->\nNext');
	});

	it('reads each further separator as a new line', () => {
		const text = '- [ ] Call Mia // bring receipts //  // ask about May // <!-- crate-id:a -->';
		const found = inlineDescription(text)!;
		expect(found.description).toBe('bring receipts\n\nask about May');
		expect(found.breaks.map(position => text.slice(position, position + 3))).toEqual([' //', ' //', ' //']);
		expect(moved(`${text}\nNext`, [1])).toBe('- [ ] Call Mia <!-- crate-id:a -->\n<!-- crate-desc:bring receipts\n\nask about May -->\nNext');
	});

	it('adds to a description the reminder already has', () => {
		expect(moved('- [ ] Call Mia // ask about May <!-- crate-id:a -->\n<!-- crate-desc:first\nsecond -->\nNext', [1]))
			.toBe('- [ ] Call Mia <!-- crate-id:a -->\n<!-- crate-desc:first\nsecond\nask about May -->\nNext');
	});

	it('encodes comment syntax and leaves lines with a broken block as typed', () => {
		expect(moved('- [ ] Call Mia // a -- b', [1])).toBe('- [ ] Call Mia\n<!-- crate-desc:v1:a%20%2D%2D%20b -->');
		const broken = '- [ ] Call Mia // more\n<!-- crate-desc:never closed';
		expect(inlineDescriptionChanges(Text.of(broken.split('\n')), [1])).toEqual([]);
	});
});

describe('where a typed description starts', () => {
	// [line, description or null when the line has none]
	const cases: [string, string | null][] = [
		['- [ ] Call Mia // bring receipts', 'bring receipts'],
		['- [x] Done task // notes', 'notes'],
		['- [X] Done task // notes', 'notes'],
		['    - [ ] Nested task // indented', 'indented'],
		['\t- [ ] Tabbed task // tabbed', 'tabbed'],
		['- [ ] Call Mia //\tafter a tab', 'after a tab'],
		['- [ ] Call Mia //   many spaces  ', 'many spaces'],
		['- [ ] Call Mia // bring receipts\r', 'bring receipts'],
		['- [ ] Read https://example.com/a // after a link', 'after a link'],
		['- [ ] Read https://example.com/a', null],
		['- [ ] See [[Notes // 2026]]', null],
		['- [ ] See [[Notes // 2026]] // real', 'real'],
		['- [ ] See [a // b](https://example.com)', null],
		['- [ ] See [a // b](https://example.com) // real', 'real'],
		['- [ ] Fix `a // b` parsing', null],
		['- [ ] Fix `a // b', null],
		['- [ ] Fix `code` // real', 'real'],
		['- [ ] Ratio 1//2', null],
		['- [ ] Comment //no space', null],
		['- [ ] Triple /// slashes', null],
		['- [ ] // no title', null],
		['- [ ]  // no title either', null],
		['- [ ] Call Mia // bring receipts <!-- crate-rule:{} --> <!-- crate-id:a -->', 'bring receipts'],
		['- [ ] Call Mia // one // two //  // four', 'one\ntwo\n\nfour'],
		['- [ ] Call Mia // // second', 'second'],
		['Plain line // not a task', null],
		['- Call Mia // a list item, not a task', null],
		['- [ ] Call Mia // a -- b', 'a -- b'],
		['- [ ] Call Mia // see <!-- inside', 'see'],
	];
	it.each(cases)('%j', (line, description) => {
		const found = inlineDescription(line);
		expect(found?.description || null).toBe(description);
		if (!found) return;
		// The parts it reports are where they say they are.
		expect(line.slice(found.from, found.from + 3)).toBe(' //');
		expect(found.start).toBeGreaterThanOrEqual(found.from + 3);
		expect(found.to).toBeLessThanOrEqual(line.replace(/\r$/, '').length);
		for (const position of found.breaks) expect(line.slice(position, position + 3)).toBe(' //');
	});
});

describe('moving a typed description under its reminder', () => {
	const lines = (doc: string) => moved(doc, [1]).split('\n');
	it('keeps the title and hidden markers on the line', () => {
		expect(lines('- [ ] Call Mia 2026-12-01 // ask <!-- crate-rule:{} --> <!-- crate-id:a -->'))
			.toEqual(['- [ ] Call Mia 2026-12-01 <!-- crate-rule:{} --> <!-- crate-id:a -->', '<!-- crate-desc:ask -->']);
	});

	it('keeps indentation and completion', () => {
		expect(lines('    - [x] Nested // done notes')).toEqual(['    - [x] Nested', '<!-- crate-desc:done notes -->']);
	});

	it('adds to an encoded description and stores the result readably when it can', () => {
		expect(lines('- [ ] Call Mia // more\n<!-- crate-desc:v1:first%20line -->')).toEqual(['- [ ] Call Mia', '<!-- crate-desc:first line', 'more -->']);
	});

	it('encodes text that would end the comment', () => {
		const [title, block] = lines('- [ ] Call Mia // ends --> here');
		expect(title).toBe('- [ ] Call Mia');
		expect(block).toMatch(/^<!-- crate-desc:v1:[^-]+ -->$/);
	});

	it('leaves lines it cannot read as typed', () => {
		const unclosed = '- [ ] Call Mia // more\n<!-- crate-desc:open';
		expect(moved(unclosed, [1])).toBe(unclosed);
		expect(moved('Plain // text', [1])).toBe('Plain // text');
	});

	it('moves only the lines it is given', () => {
		const doc = '- [ ] One // a\n- [ ] Two // b';
		expect(moved(doc, [2])).toBe('- [ ] One // a\n- [ ] Two\n<!-- crate-desc:b -->');
		expect(moved(doc, [1, 2])).toBe('- [ ] One\n<!-- crate-desc:a -->\n- [ ] Two\n<!-- crate-desc:b -->');
	});
});
