import { ARTICLE_END, ARTICLE_START, READING_IMPORT_MARKER, readingTimestamp, readingUrl, validateReadingMetadata, type ReadingChanges, type ReadingMetadata } from './model';
import { patchReadingFrontmatter, readReadingFrontmatter } from './frontmatter';

export function parseReadingNote(markdown: string): ReadingMetadata | null {
	const parsed = readReadingFrontmatter(markdown);
	if (!parsed || !Object.prototype.hasOwnProperty.call(parsed.value, 'crate_reading_version')) return null;
	return validateReadingMetadata(parsed.value);
}

export function createReadingNote(input: { id: string; url: string; title?: string; savedAt: string }): string {
	const url = readingUrl(input.url);
	const metadata = validateReadingMetadata({ crate_reading_version: 1, crate_reading_id: input.id,
		title: input.title?.trim() || new URL(url).hostname, source_url: url, saved_at: input.savedAt,
		reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'pending', capture_method: 'url' });
	return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${ARTICLE_START}\n${ARTICLE_END}\n`;
}

export function updateReadingNote(markdown: string, id: string, changes: ReadingChanges): string {
	const metadata = parseReadingNote(markdown);
	if (!metadata || metadata.crate_reading_id !== id) throw new Error('The reading note changed. Refresh before trying again.');
	// Construct the allowlist explicitly, even for callers outside TypeScript.
	const allowed: ReadingChanges = {
		...(changes.reading_status === undefined ? {} : { reading_status: changes.reading_status }),
		...(changes.favorite === undefined ? {} : { favorite: changes.favorite }),
		...(changes.tags === undefined ? {} : { tags: changes.tags }),
	};
	validateReadingMetadata({ ...metadata, ...allowed });
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

export async function adoptReadingClip(markdown: string, path: string): Promise<string> {
	const parsed = readReadingFrontmatter(markdown);
	if (!parsed || parsed.value.crate_reading_import !== READING_IMPORT_MARKER) return markdown;
	if (Object.prototype.hasOwnProperty.call(parsed.value, 'crate_reading_version')) { parseReadingNote(markdown); return markdown; }
	const value = parsed.value;
	const metadata = validateReadingMetadata({
		...value, crate_reading_version: 1, crate_reading_id: value.crate_reading_id ?? await readingImportId(path, markdown),
		saved_at: readingTimestamp(value.saved_at), reading_status: value.reading_status ?? 'inbox', favorite: value.favorite ?? false,
		tags: value.tags ?? [], extraction_status: parsed.body.trim() ? 'ready' : 'unavailable', capture_method: 'web-clipper',
	});
	return patchReadingFrontmatter(markdown, { ...metadata });
}
