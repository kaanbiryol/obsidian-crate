import type { TokenizerAndRendererExtension } from 'marked';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Keep Obsidian constructs atomic until the reader has renderers for them.
// Parsing their contents as ordinary Markdown can insert highlights into link
// targets, math commands, footnote identifiers, callout types, or block IDs.
const literal = /^(?:!?\[\[[^\r\n]*?\]\]|\[\^[^\]\r\n]+\]|\^\[[^\]\r\n]+\]|\[![\w-]+\][+-]?|\$\$(?:\\[\s\S]|(?!\$\$)[^\\])+?\$\$|\$(?!\$)(?:\\[^\r\n]|[^$\\\r\n])+?\$(?!\$)|%%[\s\S]*?%%|\^[\w-]+(?=[ \t]*(?:\n|$)))/;

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
	start: source => source.search(/^ {0,3}\$\$/m),
	tokenizer(source) {
		const match = /^ {0,3}\$\$(?:\\[\s\S]|(?!\$\$)[^\\])+?\$\$[ \t]*(?:\n|$)/.exec(source);
		if (match) return { type: 'readingMathBlock', raw: match[0] };
		return undefined;
	},
	renderer: token => `<p>${escapeHtml(token.raw.trimEnd())}</p>\n`,
}];
