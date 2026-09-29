import { describe, expect, it } from 'vitest';
import { mergeMarkdownContent } from './markdown-merge';

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

function fromArrayBuffer(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
}

describe('mergeMarkdownContent', () => {
	it.each([
		['title: Note', 'title: Note\ntags: [alpha]', 'title: Note\ntags: [beta]'],
		['title: Note', 'title: Note\nowner: Alice', 'title: Note\nstatus: done'],
		['nested:\n  first: 1\n  second: 2', 'nested:\n  first: 3\n  second: 2', 'nested:\n  first: 1\n  second: 4'],
		['default: &default old\nvalue: *default', 'default: &default local\nvalue: *default', 'default: &default old\nvalue: remote'],
	])('preserves competing frontmatter as a conflict: %s', (base, local, remote) => {
		for (const bom of ['', '\uFEFF']) for (const ending of ['\n', '\r\n']) {
			const document = (header: string) => toArrayBuffer((`${bom}---\n${header}\n---\nBody\n`).replaceAll('\n', ending));
			for (const [left, right] of [[local, remote], [remote, local]]) {
				expect(mergeMarkdownContent(document(base), document(left!), document(right!))).toEqual({ success: false, reason: 'overlap' });
			}
		}
	});

	it('preserves an authored header and BOM when merging an independent body change', () => {
		const base = '\uFEFF---\r\ntitle: Note\r\n---\r\nBody\r\n';
		const local = base.replace('title: Note', 'title: Changed');
		const remote = base.replace('Body', 'Edited body');
		for (const [left, right] of [[local, remote], [remote, local]]) {
			const result = mergeMarkdownContent(toArrayBuffer(base), toArrayBuffer(left!), toArrayBuffer(right!));
			expect(result.success).toBe(true);
			if (result.success) expect(result.text).toBe(local.replace('Body', 'Edited body'));
		}
	});

	it.each([
		['---\ntitle: Note\n---\nBody', 'Body', '---\ntitle: Changed\n---\nBody'],
		['Body', '---\ntags: [alpha]\n---\nBody', '---\ntags: [beta]\n---\nBody'],
		['---\ntitle: Note', '---\ntitle: Note\nowner: Alice', '---\ntitle: Note\nowner: Bob'],
		['```json\n{\n}\n```', '```json\n{\n"key": 1\n}\n```', '```json\n{\n"key": 2\n}\n```'],
		['~~~yaml\na: 1\nb: 2\n~~~', '~~~yaml\na: 3\nb: 2\n~~~', '~~~yaml\na: 1\nb: 4\n~~~'],
	])('does not invent combined structured content: %s', (base, local, remote) => {
		for (const [left, right] of [[local, remote], [remote, local]]) expect(mergeMarkdownContent(toArrayBuffer(base), toArrayBuffer(left!), toArrayBuffer(right!)))
			.toEqual({ success: false, reason: 'overlap' });
	});

	it('applies identical frontmatter insertions once', () => {
		const base = '---\ntitle: Note\n---\nBody\n';
		const edited = base.replace('title: Note', 'title: Note\ntags: [alpha]');
		const result = mergeMarkdownContent(toArrayBuffer(base), toArrayBuffer(edited), toArrayBuffer(edited));
		expect(result.success).toBe(true);
		if (result.success) expect(result.text).toBe(edited);
	});

	it.each(['---  ', '  ---', '\t---\t'])('protects frontmatter delimiters accepted by the reminder parser: %s', delimiter => {
		const base = `${delimiter}\ntitle: Note\n${delimiter}\nBody`;
		expect(mergeMarkdownContent(toArrayBuffer(base), toArrayBuffer(base.replace('title: Note', 'title: Note\ntags: [a]')),
			toArrayBuffer(base.replace('title: Note', 'title: Note\ntags: [b]')))).toEqual({ success: false, reason: 'overlap' });
	});
	it.each([
		['I like red apples and green pears.', 'I like ripe apples and green pears.', 'I like red apples and fresh pears.', 'I like ripe apples and fresh pears.'],
		['Meet Alice on Monday.', 'Meet Bob on Monday.', 'Meet Alice on Tuesday.', 'Meet Bob on Tuesday.'],
		['Café ☕ opens today.', 'Bistro ☕ opens today.', 'Café ☕ opens tomorrow.', 'Bistro ☕ opens tomorrow.'],
		['Keep  this word here.', 'Keep  this phrase here.', 'Keep  this word there.', 'Keep  this phrase there.'],
		['We need apples and pears.', 'We need fresh apples and pears.', 'We need apples and ripe pears.', 'We need fresh apples and ripe pears.'],
		['We need red apples and green pears.', 'We need apples and green pears.', 'We need red apples and pears.', 'We need apples and pears.'],
	])('merges independent paragraph edits: %s', (base, local, remote, expected) => {
		for (const [left, right] of [[local, remote], [remote, local]]) {
			const result = mergeMarkdownContent(toArrayBuffer(base + '\r\n'), toArrayBuffer(left + '\n'), toArrayBuffer(right + '\n'));
			expect(result.success).toBe(true);
			if (result.success) expect(result.text).toBe(expected + '\r\n');
		}
	});

	it.each([
		['Meet Alice today.', 'Meet Bob today.', 'Meet Carol today.'],
		['The cat sleeps.', 'The bat sleeps.', 'The car sleeps.'],
		['We need apples.', 'We need red apples.', 'We need green apples.'],
		['We need red apples.', 'We need apples.', 'We need green apples.'],
		['Pay 1.50 euros.', 'Pay 2.50 euros.', 'Pay 1.75 euros.'],
		['Due 2026-09-06 today.', 'Due 2027-09-06 today.', 'Due 2026-10-06 today.'],
	])('preserves conflicts for competing word edits: %s', (base, local, remote) => {
		for (const [left, right] of [[local, remote], [remote, local]]) {
			expect(mergeMarkdownContent(toArrayBuffer(base), toArrayBuffer(left!), toArrayBuffer(right!)))
				.toEqual({ success: false, reason: 'overlap' });
		}
	});

	it.each([
		['---\n', '\n---\n'],
		['```js\n', '\n```\n'],
		['~~~~js\n', '\n~~~~\n'],
		['    ', '\n'],
	])('does not refine structured Markdown conflicts inside %s', (prefix, suffix) => {
		expect(mergeMarkdownContent(
			toArrayBuffer(prefix + 'title: red and green' + suffix),
			toArrayBuffer(prefix + 'title: blue and green' + suffix),
			toArrayBuffer(prefix + 'title: red and yellow' + suffix),
		)).toEqual({ success: false, reason: 'overlap' });
	});

	it('refines prose after frontmatter and fenced code', () => {
		const prefix = '---\ntitle: note\n---\n```js\nconst n = 1;\n```\n';
		const result = mergeMarkdownContent(
			toArrayBuffer(prefix + 'Meet Alice on Monday.'),
			toArrayBuffer(prefix + 'Meet Bob on Monday.'),
			toArrayBuffer(prefix + 'Meet Alice on Tuesday.'),
		);
		expect(result.success).toBe(true);
		if (result.success) expect(result.text).toBe(prefix + 'Meet Bob on Tuesday.');
	});

	it('keeps oversized paragraph overlaps as conflicts', () => {
		const padding = 'word '.repeat(2_000);
		expect(mergeMarkdownContent(
			toArrayBuffer('Alice ' + padding + 'Monday'),
			toArrayBuffer('Bob ' + padding + 'Monday'),
			toArrayBuffer('Alice ' + padding + 'Tuesday'),
		)).toEqual({ success: false, reason: 'overlap' });
	});

	it('does not guess line alignment when a paragraph is split', () => {
		expect(mergeMarkdownContent(
			toArrayBuffer('Meet Alice on Monday.'),
			toArrayBuffer('Meet Bob\non Monday.'),
			toArrayBuffer('Meet Alice on Tuesday.'),
		)).toEqual({ success: false, reason: 'overlap' });
	});

	it('merges non-overlapping line edits', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('title\nbase local\nbase remote\n'),
			toArrayBuffer('title\nlocal edit\nbase remote\n'),
			toArrayBuffer('title\nbase local\nremote edit\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('title\nlocal edit\nremote edit\n');
		}
	});

	it('merges independent insertions at the same point in stable content order', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nb\n'),
			toArrayBuffer('a\nlocal\nb\n'),
			toArrayBuffer('a\nremote\nb\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\nlocal\nremote\nb\n');
		}
	});

	it('applies identical edits once', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nold\nb\n'),
			toArrayBuffer('a\nnew\nb\n'),
			toArrayBuffer('a\nnew\nb\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\nnew\nb\n');
		}
	});

	it('uses jsdiff alignment when another device duplicates the base line', () => {
		const base = toArrayBuffer('# A\n');
		const edited = toArrayBuffer('# B\n');
		const duplicated = toArrayBuffer('# C\n# A\n# A\n');
		for (const [local, remote] of [[edited, duplicated], [duplicated, edited]]) {
			const result = mergeMarkdownContent(base, local!, remote!);
			expect(result.success).toBe(true);
			if (result.success) expect(result.text).toBe('# C\n# B\n# A\n');
		}
	});

	it('rejects overlapping different edits', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nold\nb\n'),
			toArrayBuffer('a\nlocal\nb\n'),
			toArrayBuffer('a\nremote\nb\n'),
		);

		expect(result).toEqual({ success: false, reason: 'overlap' });
	});

	it('preserves the common base line ending and final newline style', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\r\nbase local\r\nbase remote\r\n'),
			toArrayBuffer('a\r\nlocal edit\r\nbase remote'),
			toArrayBuffer('a\nbase local\nremote edit\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\r\nlocal edit\r\nremote edit\r\n');
			expect(fromArrayBuffer(result.content)).toBe(result.text);
		}
	});

	it('produces identical bytes when the two devices swap local and remote inputs', () => {
		const base = toArrayBuffer('a\r\nb\r\n');
		const left = toArrayBuffer('a\nleft\nb\n');
		const right = toArrayBuffer('a\r\nright\r\nb');

		const leftFirst = mergeMarkdownContent(base, left, right);
		const rightFirst = mergeMarkdownContent(base, right, left);

		expect(leftFirst.success).toBe(true);
		expect(rightFirst.success).toBe(true);
		if (leftFirst.success && rightFirst.success) {
			expect(fromArrayBuffer(leftFirst.content)).toBe(fromArrayBuffer(rightFirst.content));
			expect(leftFirst.text).toBe('a\r\nleft\r\nright\r\nb\r\n');
		}
	});

	it('orders same-point Unicode insertions by code unit instead of platform collation', () => {
		const result = mergeMarkdownContent(
			toArrayBuffer('a\nb\n'),
			toArrayBuffer('a\né\nb\n'),
			toArrayBuffer('a\nz\nb\n'),
		);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.text).toBe('a\nz\né\nb\n');
		}
	});
});
