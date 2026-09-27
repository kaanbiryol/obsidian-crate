import { Marked, Renderer, type Token, type Tokens } from 'marked';
import { Parser as HtmlParser } from 'htmlparser2';
import { READING_DROP_CONTENTS, READING_HTML_TAGS } from './html-policy';
import { readingLiterals } from './markdown-literals';

type HighlightToken = Tokens.Generic & { type: 'readingHighlight'; text: string; tokens: Token[] };
export const readingMarkdown = new Marked({ async: false, gfm: true, extensions: [...readingLiterals, {
	name: 'readingHighlight', level: 'inline', start: source => source.indexOf('=='),
	tokenizer(source) {
		const match = /^==([^=\n](?:(?!==)[^\n])*?)==/.exec(source);
		if (!match || !match[1]?.trim()) return undefined;
		return { type: 'readingHighlight', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
	},
	renderer(token) { return `<mark data-crate-native="true">${this.parser.parseInline((token as HighlightToken).tokens)}</mark>`; },
}] });

const unmarkedMarkdown = new Marked({ async: false, gfm: true, extensions: [...readingLiterals, {
	name: 'readingHighlight', renderer(token) { return this.parser.parseInline((token as HighlightToken).tokens); },
}] });

interface SourceText { text: string; offsets: number[] }
interface Character { start: number; end: number; leaf: number }
export interface MarkdownDocument {
	text: string;
	/** Rendered structure with only parser-owned highlight wrappers omitted. */
	html: string;
	characters: (Character | undefined)[];
	marks: { start: number; end: number; open: number; close: number }[];
	/** Whole inline tokens can be wrapped; partial selections and blocks stay literal. */
	codes: { start: number; end: number; source?: { start: number; end: number } }[];
	autolinks: { start: number; end: number; source?: { start: number; end: number } }[];
}

/** Match parser-owned text within its parent, allowing removed list/quote prefixes. */
function locate(parent: SourceText, text: string, from = 0): SourceText | null {
	const offsets: number[] = [];
	let cursor = from;
	for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const at = parent.text.indexOf(line, cursor);
		if (at < 0) return null;
		for (let i = at; i < at + line.length; i++) offsets.push(parent.offsets[i]!);
		cursor = at + line.length;
	}
	return { text, offsets };
}

function mapTokens(tokens: Token[], parent: SourceText, mapped: WeakMap<Token, SourceText>): void {
	let cursor = 0;
	for (const token of tokens) {
		const source = locate(parent, token.raw, cursor);
		if (!source) continue;
		cursor = parent.offsets.indexOf(source.offsets.at(-1)!, cursor) + 1;
		mapped.set(token, source);
		if (token.type === 'list') mapTokens((token as Tokens.List).items, source, mapped);
		else if (token.type === 'table') {
			let cellCursor = 0;
			for (const row of [(token as Tokens.Table).header, ...(token as Tokens.Table).rows]) for (const cell of row) {
				const cellSource = locate(source, cell.text, cellCursor);
				if (cellSource) {
					mapTokens(cell.tokens, cellSource, mapped);
					cellCursor = source.offsets.indexOf(cellSource.offsets.at(-1)!, cellCursor) + 1;
				}
			}
		} else if ('tokens' in token && Array.isArray(token.tokens) && 'text' in token && typeof token.text === 'string') {
			// Link labels precede destinations. Delimiters belong to their parent, never a text leaf.
			const prefix = token.type === 'heading' ? /^ {0,3}#{1,6}\s+/.exec(source.text)?.[0].length ?? 0
				: token.type === 'list_item' ? /^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(source.text)?.[0].length ?? 0
					: ['strong', 'del', 'readingHighlight'].includes(token.type) ? 2 : ['em', 'link', 'blockquote'].includes(token.type) ? 1 : 0;
			const inner = locate(source, token.text, prefix);
			if (inner) mapTokens(token.tokens, inner, mapped);
		}
	}
}

function decodeEntity(value: string): string {
	let text = '';
	new HtmlParser({ ontext: part => { text += part; } }).end(value);
	return text;
}

function textCharacters(source: SourceText, leaf: number): { text: string; characters: Character[] } {
	let text = '';
	const characters: Character[] = [];
	for (let i = 0; i < source.text.length;) {
		const rest = source.text.slice(i);
		const escaped = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/.exec(rest);
		const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]+);/.exec(rest);
		const raw = escaped?.[0] ?? entity?.[0] ?? rest[0]!;
		const decoded = escaped?.[1] ?? (entity ? decodeEntity(raw) : raw);
		for (let j = 0; j < decoded.length; j++) characters.push({ start: source.offsets[i]!, end: source.offsets[i + raw.length - 1]! + 1, leaf });
		text += decoded; i += raw.length;
	}
	return { text, characters };
}

/** A source map for rendered text; Markdown is never serialized back from HTML. */
export function readingDocument(markdown: string): MarkdownDocument {
	const offsets: number[] = [];
	let normalized = '';
	for (let i = 0; i < markdown.length; i++) {
		offsets.push(i); normalized += markdown[i] === '\r' ? '\n' : markdown[i];
		if (markdown[i] === '\r' && markdown[i + 1] === '\n') i++;
	}
	const tokens = readingMarkdown.lexer(normalized), mapped = new WeakMap<Token, SourceText>();
	mapTokens(tokens, { text: normalized, offsets }, mapped);
	const leaves: ReturnType<typeof textCharacters>[] = [], native: { open: number; close: number }[] = [];
	const inlineCodes: { start: number; end: number }[] = [];
	const autolinks: { start: number; end: number }[] = [];
	const key = crypto.randomUUID();
	const sourceAttribute = `data-crate-source-${key}`, markAttribute = `data-crate-mark-${key}`, codeAttribute = `data-crate-code-${key}`;
	const linkAttribute = `data-crate-link-${key}`, rawAttribute = `data-crate-html-${key}`;
	const renderer = new Renderer();
	const originalRenderer = new Renderer();
	renderer.html = token => originalRenderer.html(token).replace(/^<([a-z][\w:-]*)(?=[\s/>])/i, `<$1 ${rawAttribute}="true"`);
	renderer.text = function(token) {
		originalRenderer.parser = this.parser;
		const html = originalRenderer.text(token), source = mapped.get(token);
		if ('tokens' in token && token.tokens || !source) return html;
		const id = leaves.length; leaves.push(textCharacters(source, id));
		return `<span ${sourceAttribute}="${id}">${html}</span>`;
	};
	renderer.codespan = function(token) {
		const html = originalRenderer.codespan(token), source = mapped.get(token);
		if (!source) return html;
		const id = inlineCodes.length;
		inlineCodes.push({ start: source.offsets[0]!, end: source.offsets.at(-1)! + 1 });
		return html.replace('<code>', `<code ${codeAttribute}="${id}">`);
	};
	renderer.link = function(token) {
		originalRenderer.parser = this.parser;
		const html = originalRenderer.link(token), source = mapped.get(token);
		if (token.raw.startsWith('[') || !source) return html;
		const id = autolinks.length;
		autolinks.push({ start: source.offsets[0]!, end: source.offsets.at(-1)! + 1 });
		return html.replace('<a ', `<a ${linkAttribute}="${id}" `);
	};
	const parser = new Marked({ async: false, gfm: true, renderer, extensions: [...readingLiterals, {
		name: 'readingHighlight', renderer(token) {
			const source = mapped.get(token);
			const id = native.length;
			if (source) native.push({ open: source.offsets[0]!, close: source.offsets.at(-1)! - 1 });
			return `<mark${source ? ` ${markAttribute}="${id}"` : ''}>${this.parser.parseInline((token as HighlightToken).tokens)}</mark>`;
		},
	}] });
	const result: MarkdownDocument = { text: '', html: unmarkedMarkdown.parser(tokens), characters: [], marks: [], codes: [], autolinks: [] };
	const stack: { start: number; leaf?: number; mark?: number; code: boolean; inlineCode?: number; autolink?: number; hidden: boolean; raw: boolean }[] = [];
	let hidden = 0;
	const parserHtml = new HtmlParser({
		onopentag(name, attributes) {
			const drop = READING_DROP_CONTENTS.includes(name) && !READING_HTML_TAGS.includes(name);
			if (drop) hidden++;
			stack.push({ start: result.text.length, hidden: drop, code: name === 'code', raw: attributes[rawAttribute] !== undefined,
				...(attributes[sourceAttribute] === undefined ? {} : { leaf: Number(attributes[sourceAttribute]) }),
				...(attributes[markAttribute] === undefined ? {} : { mark: Number(attributes[markAttribute]) }),
				...(attributes[codeAttribute] === undefined ? {} : { inlineCode: Number(attributes[codeAttribute]) }),
				...(attributes[linkAttribute] === undefined ? {} : { autolink: Number(attributes[linkAttribute]) }),
			});
		},
		ontext(text) {
			if (hidden) return;
			result.text += text;
			for (let i = 0; i < text.length; i++) result.characters.push(undefined);
		},
		onclosetag() {
			const entry = stack.pop();
			if (!entry) return;
			if (entry.hidden) hidden--;
			const raw = entry.raw || stack.some(parent => parent.raw);
			const leaf = entry.leaf === undefined ? undefined : leaves[entry.leaf];
			if (!raw && leaf?.text === result.text.slice(entry.start)) for (let i = 0; i < leaf.characters.length; i++) result.characters[entry.start + i] = leaf.characters[i];
			const mark = entry.mark === undefined ? undefined : native[entry.mark];
			if (mark) result.marks.push({ start: entry.start, end: result.text.length, ...mark });
			if (entry.code && !hidden) result.codes.push({ start: entry.start, end: result.text.length,
				...(raw || entry.inlineCode === undefined ? {} : { source: inlineCodes[entry.inlineCode] }),
			});
			if (entry.autolink !== undefined && !hidden) result.autolinks.push({ start: entry.start, end: result.text.length, ...(raw ? {} : { source: autolinks[entry.autolink] }) });
		},
	});
	parserHtml.end(parser.parser(tokens));
	result.marks.sort((a, b) => a.start - b.start);
	return result;
}
