import { youtubeVideoId } from './youtube';
import { ARTICLE_START, ARTICLE_END, MAX_READING_BYTES, type ReadingItem, type ReadingMetadata } from './model';
import { parseReadingNote } from './notes';
import { patchReadingFrontmatter } from './frontmatter';
import { transcriptMetadata, type CapturedArticle } from '../extraction/types';

export function managedArticle(content: string): { start: number; end: number; text: string } | null {
	const start = content.indexOf(ARTICLE_START), end = content.indexOf(ARTICLE_END);
	if (start < 0 || end < start || content.indexOf(ARTICLE_START, start + 1) >= 0 || content.indexOf(ARTICLE_END, end + 1) >= 0) return null;
	return { start: start + ARTICLE_START.length, end, text: content.slice(start + ARTICLE_START.length, end) };
}

type ArticlePublication =
	| { kind: 'capture'; article: CapturedArticle | null; resolvedUrl?: string }
	| { kind: 'extraction'; article: CapturedArticle | null; block: NonNullable<ReturnType<typeof managedArticle>>; resolvedUrl?: string }
	| { kind: 'local'; article: CapturedArticle; block: NonNullable<ReturnType<typeof managedArticle>> };

function replaceArticle(content: string, block: NonNullable<ReturnType<typeof managedArticle>>, article: CapturedArticle): string {
	return `${content.slice(0, block.start)}\n\n${article.markdown}\n\n${content.slice(block.end)}`;
}

// Dataview JS, JS Engine and Tasks custom filter/group/sort functions run these code blocks when the note renders.
const EXECUTABLE_FENCES = new Set(['dataviewjs', 'js-engine', 'tasks']);
// A zero-width space keeps the text readable while breaking a plugin's trigger.
const BREAK = '\u200B';

/** Templater runs `<% ... %>` anywhere in a new note, including code and frontmatter. */
function inertTemplater(text: string): string {
	return text.split('<%').join(`<${BREAK}%`);
}

/** Dataview runs inline code, including raw HTML `<code>`, whose text starts with `$=`. */
function inertInlineCode(line: string): string {
	const text = line.replace(/(<code\b[^>]*>\s*)\$=/gi, (_match, open: string) => `${open}$${BREAK}=`);
	const outside = /\\[\s\S]|`+/g, inside = /`+/g;
	let output = '', copied = 0;
	for (let open = outside.exec(text); open; open = outside.exec(text)) {
		if (open[0][0] === '\\') continue;
		inside.lastIndex = outside.lastIndex;
		let close = inside.exec(text);
		while (close && close[0].length !== open[0].length) close = inside.exec(text);
		// An unmatched backtick run is literal text.
		if (!close) continue;
		const prefix = /^\s*\$=/.exec(text.slice(outside.lastIndex, close.index));
		if (prefix) {
			const equals = outside.lastIndex + prefix[0].length - 1;
			output += text.slice(copied, equals) + BREAK;
			copied = equals;
		}
		outside.lastIndex = inside.lastIndex;
	}
	return output + text.slice(copied);
}

/** Saved web pages must not bring plugin code into the vault. Executable code blocks
 * stay readable as plain code; Defuddle fences are longer than any backtick run inside them. */
function inertArticle(article: CapturedArticle): CapturedArticle {
	let fence = '', firstLine = false;
	const markdown = article.markdown.split('\n').map(line => {
		const match = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
		const marker = match && !(match[2]![0] === '`' && match[3]!.includes('`')) ? match : null;
		if (fence) {
			if (marker && marker[2]!.startsWith(fence) && !marker[3]!.trim()) fence = '';
			// Dataview's inline queries in code blocks also run a block whose text starts with `$=`.
			else if (firstLine) line = line.replace(/^((?:[ \t]*>)*\s*)\$=/, (_match, prefix: string) => `${prefix}$${BREAK}=`);
			firstLine = false;
			return line;
		}
		if (!marker) return inertInlineCode(line);
		fence = marker[2]!;
		firstLine = true;
		return EXECUTABLE_FENCES.has(marker[3]!.trim().split(/\s/)[0]!.toLowerCase()) ? marker[1]! + fence : line;
	}).join('\n');
	return { ...article, markdown: inertTemplater(markdown),
		...(article.title === undefined ? {} : { title: inertTemplater(article.title) }),
		...(article.author === undefined ? {} : { author: inertTemplater(article.author) }) };
}

/** Assemble verified source text; callers retain source eligibility and publication guards. */
export function assembleReadingArticle(content: string, metadata: ReadingMetadata, publication: ArticlePublication): { content: string; title: string } {
	const article = publication.article && inertArticle(publication.article);
	const capture = publication.kind === 'capture';
	const replacementTitle = article?.title && (!capture || article.title.trim()) && metadata.title === new URL(metadata.source_url).hostname
		? article.title : undefined;
	const title = replacementTitle ?? metadata.title;
	const changes = {
		...(capture ? { title } : {}),
		extraction_status: article ? 'ready' : 'unavailable',
		...(article ? transcriptMetadata(article) : {}),
		...(!capture && replacementTitle !== undefined ? { title: replacementTitle } : {}),
		...(article?.author && (capture || !metadata.author) ? { author: article.author } : {}),
		...(article?.faviconUrl && (capture || !metadata.favicon_url) ? { favicon_url: article.faviconUrl } : {}),
		...(article && publication.kind !== 'local' && publication.resolvedUrl ? { resolved_url: publication.resolvedUrl } : {}),
	};
	// New captures patch their initial metadata before locating the article block.
	// Existing sources keep their verified offsets and validate the assembled text
	// through the frontmatter patch, preserving size/error ordering in each path.
	if (publication.kind !== 'capture' && article) content = replaceArticle(content, publication.block, article);
	content = patchReadingFrontmatter(content, changes);
	if (capture && article) content = replaceArticle(content, managedArticle(content)!, article);
	return { content, title };
}

/** Only enrich the empty bookmark that initiated the download; keep current metadata and personal notes. */
export function applyLocalArticle(content: string, item: ReadingItem, article: CapturedArticle): string {
	const metadata = parseReadingNote(content), block = managedArticle(content);
	if (metadata?.crate_reading_id !== item.crate_reading_id || metadata.source_url !== item.source_url
		|| metadata.capture_method !== 'url' || !(['unavailable', 'pending'].includes(metadata.extraction_status) || youtubeVideoId(metadata.source_url)) || !block || block.text.trim()) {
		throw new Error('The reading note changed. Its current contents have been kept.');
	}
	const { content: result } = assembleReadingArticle(content, metadata, { kind: 'local', article, block });
	if (new TextEncoder().encode(result).length > MAX_READING_BYTES) throw new Error('The reading note exceeds the 1 MB limit.');
	return result;
}
