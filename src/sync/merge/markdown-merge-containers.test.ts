import { describe, expect, it } from 'vitest';
import { mergeMarkdownContent } from './markdown-merge';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const merge = (base: string, local: string, remote: string) => mergeMarkdownContent(bytes(base), bytes(local), bytes(remote));
const containers = [
	['plain', '', '', ''],
	['callout', '> [!example]\n', '> ', '> '],
	['nested quote', '> [!note]\n', '> > ', '> > '],
	['compact quote', '', '>>', '>>'],
	['unordered list', '', '- ', '  '],
	['ordered list', '', '12. ', '    '],
	['parenthesized list', '', '1) ', '   '],
	['list in quote', '> [!note]\n', '> - ', '>   '],
	['quote in list', '', '- > ', '  > '],
	['nested lists', '', '- 1. ', '     '],
] as const;

describe('structured merge boundaries inside Markdown containers', () => {
	it.each(containers)('preserves competing fenced edits in %s', (_name, preamble, opening, continuation) => {
		for (const marker of ['```', '~~~~']) for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
			const base = `${bom}${preamble}${opening}${marker}yaml\n${continuation}name: example\n${continuation}${marker}\n`.replaceAll('\n', eol);
			const local = base.replace(`${continuation}name: example`, `${continuation}enabled: true${eol}${continuation}name: example`);
			const remote = base.replace(`${continuation}name: example`, `${continuation}name: example${eol}${continuation}enabled: false`);
			for (const [left, right] of [[local, remote], [remote, local]]) expect(merge(base, left!, right!)).toEqual({ success: false, reason: 'overlap' });
			for (const [left, right] of [[local, base], [base, local], [local, local]]) {
				expect(merge(base, left!, right!)).toMatchObject({ success: true, text: local });
			}
		}
	});
	it.each(['> > ```', '> - ```', '>     ```', '> ``', '> ~~~', '> ``` not a closer'])('does not end a quoted fence at literal code: %s', literal => {
		const base = `> [!note]\n> \`\`\`text\n${literal}\n> a: 1\n> b: 2\n> \`\`\`\n`;
		expect(merge(base, base.replace('a: 1', 'a: 3'), base.replace('b: 2', 'b: 4'))).toEqual({ success: false, reason: 'overlap' });
	});
	it('protects an unterminated callout fence through the end of the document', () => {
		const base = '> [!note]\n> ```yaml\n> a: 1\n> b: 2\n';
		expect(merge(base, base.replace('a: 1', 'a: 3'), base.replace('b: 2', 'b: 4'))).toEqual({ success: false, reason: 'overlap' });
	});
	it('merges changes in separate quoted and list fences without changing either authored block', () => {
		const base = '> ```yaml\n> a: 1\n> ```\n\n- ~~~yaml\n  b: 2\n  ~~~\n';
		expect(merge(base, base.replace('a: 1', 'a: 3'), base.replace('b: 2', 'b: 4')))
			.toMatchObject({ success: true, text: base.replace('a: 1', 'a: 3').replace('b: 2', 'b: 4') });
	});
});
