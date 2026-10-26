import type { TokenizerAndRendererExtension } from 'marked';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Keep Obsidian constructs atomic until the reader has renderers for them.
// Parsing their contents as ordinary Markdown can insert highlights into link
// targets, math commands, footnote identifiers, callout types, or block IDs.
const literal = /^(?:!?\[\[[^\r\n]*?\]\]|\[\^[^\]\r\n]+\]|\^\[[^\]\r\n]+\]|\[![\w-]+\][+-]?|\$\$(?:\\[\s\S]|(?!\$\$)[^\\])+?\$\$|\$(?!\$)(?:\\[^\r\n]|[^$\\\r\n])+?\$(?!\$)|%%[\s\S]*?%%|\^[\w-]+(?=[ \t]*(?:\n|$)))/;
/** `source.search(/^ {0,3}\$\$/m)`: marked calls it with the rest of the note at every
 * paragraph, and `indexOf` skips text far faster than that regex can. */
function mathBlockStart(source: string): number {
	for (let at = source.indexOf('$$'); at >= 0; at = source.indexOf('$$', at + 1)) {
		let line = at;
		while (line > 0 && at - line < 3 && source[line - 1] === ' ') line--;
		if (line === 0 || /[\n\r\u2028\u2029]/.test(source[line - 1]!)) return line;
	}
	return -1;
}

export const readingLiterals: TokenizerAndRendererExtension[] = [{
	name: 'readingLiteral', level: 'inline',
	start: source => source.search(/!?\[\[|\[\^|\^\[|\[!|\$|%%|\^[\w-]/),
	tokenizer(source) {
		const match = literal.exec(source);
		if (match) return { type: 'readingLiteral', raw: match[0] };
		return undefined;
	},
	renderer: token => escapeHtml(token.raw),
}, {
	name: 'readingMathBlock', level: 'block',
	start: mathBlockStart,
	tokenizer(source) {
		const match = /^ {0,3}\$\$(?:\\[\s\S]|(?!\$\$)[^\\])+?\$\$[ \t]*(?:\n|$)/.exec(source);
		if (match) return { type: 'readingMathBlock', raw: match[0] };
		return undefined;
	},
	renderer: token => `<p>${escapeHtml(token.raw.trimEnd())}</p>\n`,
}];
