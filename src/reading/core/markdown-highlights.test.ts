import { describe, expect, it } from 'vitest';
import { readingDocument } from './markdown';
import { readMarkdownHighlights, writeMarkdownHighlights } from './markdown-highlights';

describe('source-preserving Markdown highlights', () => {
	it.each([
		'Hello **world** and [a link](https://example.com/world).\n',
		'Use `DSButton` with a `ButtonStyle` and a [link](https://example.com).\n',
		'Use ``a ` b`` and \\`literal backticks\\` here.\n',
		'Further reading (see [1](https://example.com/one), [2](https://example.com/two)).\n',
		'\n<!-- crate:article:start -->\nAn article with **formatting**.\n<!-- crate:article:end -->\n',
		'# Heading\n\nFirst paragraph.\n\nSecond *paragraph*.\n',
		'> A quote\n> with **formatting**.\n\n- A list\n- More text\n',
		'Hello &amp; goodbye \\*literal\\* 😀.\r\n',
		'| Name | Value |\n| --- | --- |\n| Hello | World |\n',
		'1. 1\n2. 2\n\n# # heading\n\n- [x] task\n  continuation\n',
	])('preserves the source around delimiters: %s', markdown => {
		const document = readingDocument(markdown), text = document.text.trimEnd();
		const saved = writeMarkdownHighlights(markdown, [{ start: 0, end: text.length, text }]);
		expect(saved.markdown).toContain('==');
		expect(readingDocument(saved.markdown).text).toBe(document.text);
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toHaveLength(1);
		expect(writeMarkdownHighlights(saved.markdown, []).markdown).toBe(markdown);
	});
	it('reads native markers while excluding code and escaped markers', () => {
		const markdown = 'A ==highlight== and `==code==` and \\==literal==.\n';
		const result = readMarkdownHighlights(markdown);
		expect(result.highlights.map(h => h.text)).toEqual(['highlight']);
	});
	it('closes single-character highlights before later markers on the same line', () => {
		const result = readMarkdownHighlights('==1== and ==2==, then ==more text==.\n');
		expect(result.highlights.map(highlight => highlight.text)).toEqual(['1', '2', 'more text']);
	});
	it('resizes a highlight across bold text and trailing punctuation', () => {
		const markdown = 'A useful **article excerpt**.\n\nAnother paragraph to read.';
		const saved = writeMarkdownHighlights(markdown, [{ start: 2, end: 25, text: 'useful article excerpt.' }]);
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toHaveLength(1);
	});
	it('rejects changed text and overlaps without changing the source', () => {
		expect(() => writeMarkdownHighlights('Changed', [{ start: 0, end: 5, text: 'Hello' }])).toThrow('changed');
		expect(() => writeMarkdownHighlights('Hello', [{ start: 0, end: 4, text: 'Hell' }, { start: 1, end: 5, text: 'ello' }])).toThrow('overlaps');
	});
	it('wraps complete inline code outside its original backticks', () => {
		const saved = writeMarkdownHighlights('Use `DSButton`.', [{ start: 4, end: 12, text: 'DSButton' }]);
		expect(saved.markdown).toBe('Use ==`DSButton`==.');
		expect(saved.highlights[0]?.codeAnchor).toBeUndefined();
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toHaveLength(1);
		expect(readMarkdownHighlights('Use `DSButton`.', saved.highlights).highlights).toEqual([]);
	});
	it.each([
		['Use `DSButton`.', 'Button'],
		['Use ` value ` here.', 'alu'],
		['Use `first\nsecond` here.', 'first second'],
		['Compare `a == b` here.', 'a == b'],
		['```swift\nlet kind = "primary"\nprint(kind)\n```\n', 'kind = "primary"\nprint(kind)'],
		['~~~swift\r\nlet kind = "primary"\r\n~~~\r\n', 'kind'],
		['    let kind = "primary"\n    print(kind)\n', 'kind'],
		['<pre><code>let kind = &quot;primary&quot;</code></pre>\n', 'kind = "primary"'],
	])('anchors literal code without changing its source: %s', (markdown, excerpt) => {
		const document = readingDocument(markdown), start = document.text.indexOf(excerpt);
		expect(start).toBeGreaterThanOrEqual(0);
		const saved = writeMarkdownHighlights(markdown, [{ start, end: start + excerpt.length, text: excerpt, note: 'Keep this' }]);
		expect(saved.markdown).toBe(markdown);
		expect(saved.highlights[0]).toMatchObject({ codeAnchor: true, text: excerpt, note: 'Keep this' });
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toEqual(saved.highlights);
		expect(writeMarkdownHighlights(saved.markdown, []).markdown).toBe(markdown);
	});
	it('uses markers for prose and anchors for code within one selection', () => {
		const markdown = 'Before the example.\n\n```swift\nlet kind = "primary"\n```\n\nAfter the example.\n';
		const text = readingDocument(markdown).text.trimEnd();
		const saved = writeMarkdownHighlights(markdown, [{ start: 0, end: text.length, text }]);
		expect(saved.markdown).toBe('==Before the example.==\n\n```swift\nlet kind = "primary"\n```\n\n==After the example.==\n');
		expect(saved.highlights[0]?.codeAnchor).toBe(true);
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toEqual(saved.highlights);
		expect(writeMarkdownHighlights(saved.markdown, []).markdown).toBe(markdown);
	});
	it('recalculates code anchors when resizing between a partial and complete token', () => {
		const partial = writeMarkdownHighlights('Use `DSButton`.', [{ start: 6, end: 12, text: 'Button' }]);
		const whole = writeMarkdownHighlights(partial.markdown, [{ start: 4, end: 12, text: 'DSButton', codeAnchor: true }]);
		expect(whole.markdown).toBe('Use ==`DSButton`==.');
		expect(whole.highlights[0]?.codeAnchor).toBeUndefined();
		const resized = writeMarkdownHighlights(whole.markdown, [{ start: 6, end: 12, text: 'Button' }]);
		expect(resized.markdown).toBe(partial.markdown);
		expect(resized.highlights[0]?.codeAnchor).toBe(true);
	});
	it('retains missing code excerpts for recovery and never uses code anchors to repaint prose', () => {
		const saved = writeMarkdownHighlights('Use `DSButton`.', [{ start: 6, end: 12, text: 'Button' }]);
		const shifted = readMarkdownHighlights(`A new paragraph.\n\n${saved.markdown}`, saved.highlights);
		expect(shifted.highlights[0]).toMatchObject({ id: saved.highlights[0]!.id, text: 'Button', codeAnchor: true });
		for (const markdown of ['Use DSButton.', 'Use `something else`.']) {
			const result = readMarkdownHighlights(markdown, saved.highlights);
			expect(result.highlights).toEqual([]);
			expect(result.recovery[0]?.text).toBe('Button');
		}
	});
	it('uses text context to keep identity when earlier paragraphs change', () => {
		const saved = writeMarkdownHighlights('Hello world.\n', [{ start: 6, end: 11, text: 'world' }]);
		const result = readMarkdownHighlights(`New paragraph.\n\n${saved.markdown}`, saved.highlights);
		expect(result.highlights).toHaveLength(1);
		expect(result.highlights[0]).toMatchObject({ id: saved.highlights[0]!.id, text: 'world', start: 21 });
		expect(() => writeMarkdownHighlights(`New paragraph.\n\n${saved.markdown}`, result.highlights)).not.toThrow();
	});
	it('respects removed native markers and retains orphaned annotations for recovery', () => {
		const saved = writeMarkdownHighlights('Hello world.\n', [{ start: 6, end: 11, text: 'world', note: 'Remember this' }]);
		const result = readMarkdownHighlights('Hello world.\n', saved.highlights);
		expect(result.highlights).toEqual([]);
		expect(result.recovery[0]?.note).toBe('Remember this');
	});
	it('uses expanded native markers and preserves the old annotation for recovery', () => {
		const saved = writeMarkdownHighlights('Hello world.\n', [{ start: 6, end: 11, text: 'world', note: 'Remember this' }]);
		const result = readMarkdownHighlights('==Hello world==.\n', saved.highlights);
		expect(result.highlights.map(highlight => highlight.text)).toEqual(['Hello world']);
		expect(result.recovery[0]?.note).toBe('Remember this');
		expect(() => writeMarkdownHighlights('==Hello world==.\n', result.highlights)).not.toThrow();
	});
	it('does not create overlapping excerpts when a repeated highlighted passage is deleted', () => {
		const saved = writeMarkdownHighlights('Hello world.\n\nHello world.\n', [
			{ start: 6, end: 11, text: 'world', note: 'First note' },
			{ start: 19, end: 24, text: 'world', note: 'Second note' },
		]);
		const result = readMarkdownHighlights('Hello ==world==.\n', saved.highlights);
		expect(result.highlights).toHaveLength(1);
		expect(result.highlights[0]?.note).toBeUndefined();
		expect(result.recovery.map(highlight => highlight.note)).toEqual(['First note', 'Second note']);
		expect(() => writeMarkdownHighlights('Hello ==world==.\n', result.highlights)).not.toThrow();
	});
	it('keeps adjacent highlights separate and never rewrites link destinations', () => {
		const saved = writeMarkdownHighlights('[Hello](https://example.com/Hello)', [{ start: 0, end: 2, text: 'He' }, { start: 2, end: 5, text: 'llo' }]);
		expect(saved.markdown).toBe('[==He====llo==](https://example.com/Hello)');
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toHaveLength(2);
	});
	it('does not treat raw HTML attributes as a Markdown source map', () => {
		const markdown = 'Hello\n\n<div data-crate-source="0">Hello</div>';
		const document = readingDocument(markdown), start = document.text.lastIndexOf('Hello');
		const saved = writeMarkdownHighlights(markdown, [{ start, end: start + 5, text: 'Hello' }]);
		expect(saved.markdown).toBe(markdown);
		expect(saved.highlights[0]).toMatchObject({ start, text: 'Hello', textAnchor: true });
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toEqual(saved.highlights);
	});
	it.each([
		['Visit <https://example.com> today.', 'https://example.com'],
		['Visit https://example.org/path?value=1 today.', 'https://example.org/path?value=1'],
		['Visit www.example.com today.', 'www.example.com'],
		['Email <hello@example.com> today.', 'hello@example.com'],
	])('highlights entire autolinks without changing their destinations: %s', (markdown, text) => {
		const document = readingDocument(markdown), start = document.text.indexOf(text);
		const saved = writeMarkdownHighlights(markdown, [{ start, end: start + text.length, text }]);
		expect(saved.markdown).toContain('==');
		expect(saved.highlights[0]?.textAnchor).toBeUndefined();
		expect(readingDocument(saved.markdown).html).toBe(document.html);
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toEqual(saved.highlights);
		expect(writeMarkdownHighlights(saved.markdown, []).markdown).toBe(markdown);
	});
	it.each([
		['Visit <https://example.com> today.', 'example.com'],
		['Visit https://example.org today.', 'example.org'],
		['| Name | Value |\n| --- | --- |\n| a\\|b | `x` |\n', 'a|b'],
		['Compare a == b in ordinary text.\n', 'a == b'],
		['<div>Embedded <strong>HTML</strong> content.</div>\n', 'Embedded HTML content.'],
		['<a href="https://example.com">Raw link label</a>\n', 'Raw link label'],
		['An [[Article#Heading|alias]] and ![[Diagram.svg]] here.', 'Article#Heading'],
		['An [[Article#Heading|alias]] and ![[Diagram.svg]] here.', 'Diagram.svg'],
		['Use $E = mc^2$ and $a == b == c$ here.', 'E = mc^2'],
		['Use $a == b == c$ here.', 'a == b == c'],
		['$$\n\\frac{a}{b}\n\n+ c\n$$\n', '\\frac{a}{b}'],
		['A footnote[^important] and inline ^[A note] here.', 'important'],
		['A footnote[^important] and inline ^[A note] here.', 'A note'],
		['> [!note]+ A callout\n> Callout text.\n', 'note'],
		['A paragraph. ^block-id\n', 'block-id'],
		['%%Preserve this comment%%\n', 'Preserve this comment'],
	])('anchors source-sensitive text without editing its Markdown: %s', (markdown, text) => {
		const document = readingDocument(markdown), start = document.text.indexOf(text);
		expect(start).toBeGreaterThanOrEqual(0);
		const saved = writeMarkdownHighlights(markdown, [{ start, end: start + text.length, text, note: 'Keep this' }]);
		expect(saved.markdown).toBe(markdown);
		expect(saved.highlights[0]).toMatchObject({ text, note: 'Keep this', textAnchor: true });
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toEqual(saved.highlights);
		expect(writeMarkdownHighlights(saved.markdown, []).markdown).toBe(markdown);
	});
	it('keeps native highlights beside a passage that needs the annotation fallback', () => {
		const markdown = 'Normal prose.\n\nCompare a == b here.\n\nAnother paragraph.\n';
		const document = readingDocument(markdown);
		const selections = ['Normal', 'a == b', 'Another'].map(text => {
			const start = document.text.indexOf(text);
			return { start, end: start + text.length, text };
		});
		const saved = writeMarkdownHighlights(markdown, selections);
		expect(saved.markdown).toBe('==Normal== prose.\n\nCompare a == b here.\n\n==Another== paragraph.\n');
		expect(saved.highlights.map(highlight => !!highlight.textAnchor)).toEqual([false, true, false]);
		expect(readMarkdownHighlights(saved.markdown, saved.highlights).highlights).toEqual(saved.highlights);
		expect(writeMarkdownHighlights(saved.markdown, []).markdown).toBe(markdown);
	});
	it('recalculates annotations when resizing and retains identity and notes', () => {
		const partial = writeMarkdownHighlights('Visit https://example.com today.', [{ start: 14, end: 21, text: 'example', note: 'Keep this' }]);
		expect(partial.highlights[0]?.textAnchor).toBe(true);
		const whole = writeMarkdownHighlights(partial.markdown, [{ ...partial.highlights[0]!, start: 6, end: 25, text: 'https://example.com', prefix: undefined, suffix: undefined }]);
		expect(whole.markdown).toBe('Visit ==https://example.com== today.');
		expect(whole.highlights[0]?.textAnchor).toBeUndefined();
		expect(whole.highlights[0]).toMatchObject({ id: partial.highlights[0]!.id, note: 'Keep this' });
	});
	it('reanchors text annotations after edits and recovers missing or ambiguous excerpts', () => {
		const markdown = '<div>Some embedded HTML.</div>\n';
		const saved = writeMarkdownHighlights(markdown, [{ start: 5, end: 13, text: 'embedded' }]);
		const moved = readMarkdownHighlights(`New paragraph.\n\n${markdown}`, saved.highlights);
		expect(moved.highlights[0]).toMatchObject({ id: saved.highlights[0]!.id, text: 'embedded', textAnchor: true });
		for (const source of ['<div>Some changed HTML.</div>\n', markdown + markdown]) {
			const result = readMarkdownHighlights(source, saved.highlights);
			expect(result.highlights).toEqual([]);
			expect(result.recovery).toEqual(saved.highlights);
		}
	});
	it('does not interpret equality inside Obsidian constructs as native highlight markers', () => {
		const markdown = 'Use $a == b == c$ with [[A == title == here]].\n';
		expect(readMarkdownHighlights(markdown).highlights).toEqual([]);
		expect(writeMarkdownHighlights(markdown, []).markdown).toBe(markdown);
	});
	it('refuses partial Unicode characters or entities that decode into multiple characters', () => {
		expect(() => writeMarkdownHighlights('😀', [{ start: 0, end: 1, text: '\uD83D' }])).toThrow('whole character');
		const text = readingDocument('&NotEqualTilde;').text;
		expect(() => writeMarkdownHighlights('&NotEqualTilde;', [{ start: 0, end: 1, text: text[0]! }])).toThrow('whole character');
	});
});
