import { ARTICLE_END, ARTICLE_START, readingTimestamp, readingUrl, validateReadingMetadata, type ReadingChanges, type ReadingMetadata } from './model';
import { patchReadingFrontmatter, readReadingFrontmatter } from './frontmatter';
import { readMarkdownHighlights, writeMarkdownHighlights } from './markdown-highlights';

export function parseReadingNote(markdown: string): ReadingMetadata | null {
	const parsed = readReadingFrontmatter(markdown);
	if (!parsed || !Object.prototype.hasOwnProperty.call(parsed.value, 'crate_reading_version')) return null;
	const metadata = validateReadingMetadata(parsed.value);
	if (!metadata.highlights?.length && !parsed.body.includes('==')) return metadata;
	const { highlights, recovery } = readMarkdownHighlights(parsed.body, metadata.highlights, !metadata.highlight_format);
	return { ...metadata, highlights, ...(recovery.length ? { highlight_recovery: [...(metadata.highlight_recovery ?? []), ...recovery] } : {}) };
}

export function createReadingNote(input: { id: string; url: string; title?: string; savedAt: string }): string {
	const url = readingUrl(input.url);
	const metadata = validateReadingMetadata({ crate_reading_version: 1, crate_reading_id: input.id,
		title: input.title?.trim() || new URL(url).hostname, source_url: url, saved_at: input.savedAt,
		reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'pending', capture_method: 'url' });
	return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${ARTICLE_START}\n${ARTICLE_END}\n`;
}

export function updateReadingNote(markdown: string, id: string, changes: ReadingChanges): string {
	const metadata = parseReadingNote(markdown);
	if (!metadata || metadata.crate_reading_id !== id) throw new Error('The reading note changed. Refresh before trying again.');
	// Construct the allowlist explicitly, even for callers outside TypeScript.
	const allowed: ReadingChanges = {
		...(changes.highlights === undefined ? {} : { highlights: changes.highlights }),
		...(changes.reading_status === undefined ? {} : { reading_status: changes.reading_status }),
		...(changes.favorite === undefined ? {} : { favorite: changes.favorite }),
		...(changes.tags === undefined ? {} : { tags: changes.tags }),
	};
	validateReadingMetadata({ ...metadata, ...allowed });
	if (changes.highlights !== undefined || (!metadata.highlight_format && metadata.highlights?.length)) {
		const parsed = readReadingFrontmatter(markdown)!;
		const written = writeMarkdownHighlights(parsed.body, allowed.highlights ?? metadata.highlights ?? []);
		markdown = markdown.slice(0, markdown.length - parsed.body.length) + written.markdown;
		return patchReadingFrontmatter(markdown, { ...allowed, highlights: written.highlights, highlight_format: 'markdown-v1',
			...(metadata.highlight_recovery?.length ? { highlight_recovery: metadata.highlight_recovery } : {}) });
	}
	return patchReadingFrontmatter(markdown, allowed);
}

/** A versioned, content-derived UUID; once persisted it is never recalculated on rename. */
export async function readingImportId(path: string, original: string): Promise<string> {
	const source = JSON.stringify(['crate:reading:clipper-import:v1', path.normalize('NFC'), original]);
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)));
	bytes[6] = (bytes[6]! & 15) | 128; // UUIDv8, application-defined SHA-256 namespace.
	bytes[8] = (bytes[8]! & 63) | 128;
	const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Called only for Markdown inside the configured Reading folder. */
export async function adoptReadingClip(markdown: string, path: string, savedAt: string): Promise<string> {
	const parsed = readReadingFrontmatter(markdown);
	const value = parsed?.value ?? {};
	if (Object.prototype.hasOwnProperty.call(value, 'crate_reading_version')) { parseReadingNote(markdown); return markdown; }
	const body = parsed?.body ?? markdown;
	// Default Clipper templates use source and may save authors as a list.
	const source = value.source_url ?? value.source ?? value.url;
	const author = Array.isArray(value.author) && value.author.every(entry => typeof entry === 'string')
		? value.author.join(', ') : value.author;
	const metadata = validateReadingMetadata({
		...value, crate_reading_version: 1, crate_reading_id: value.crate_reading_id ?? await readingImportId(path, markdown),
		title: value.title ?? path.split('/').pop()!.replace(/\.md$/i, ''), source_url: source == null || source === '' ? '' : readingUrl(source),
		saved_at: readingTimestamp(value.saved_at ?? savedAt), reading_status: value.reading_status ?? 'inbox', favorite: value.favorite ?? false,
		tags: typeof value.tags === 'string' ? value.tags.split(/[,\s]+/).filter(Boolean) : value.tags ?? [],
		author: author ?? (Object.prototype.hasOwnProperty.call(value, 'author') ? '' : undefined), extraction_status: body.trim() ? 'ready' : 'unavailable', capture_method: 'web-clipper',
	});
	return patchReadingFrontmatter(markdown, { ...metadata });
}
