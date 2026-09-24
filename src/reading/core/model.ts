/** The portable Markdown contract shared by local capture and the server. */
export interface ReadingMetadata {
	crate_reading_version: 1;
	crate_reading_id: string;
	title: string;
	source_url: string;
	saved_at: string;
	reading_status: 'inbox' | 'archived';
	favorite: boolean;
	tags: string[];
	extraction_status: 'pending' | 'ready' | 'unavailable';
	capture_method?: 'url' | 'web-clipper';
	author?: string;
	resolved_url?: string;
	favicon_url?: string;
}

export type ReadingChanges = Partial<Pick<ReadingMetadata, 'reading_status' | 'favorite' | 'tags'>>;
export interface ReadingItem extends ReadingMetadata { path: string }
export const READING_IMPORT_MARKER = 'web-clipper-v1';
export const ARTICLE_START = '<!-- crate:article:start -->';
export const ARTICLE_END = '<!-- crate:article:end -->';
export const MAX_READING_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readingUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 8192) throw new Error('Enter a valid web link.');
	let url: URL;
	try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete link starting with https:// or http://.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Use an HTTP or HTTPS link without embedded credentials.');
	}
	return url.href;
}

/** Icons are displayed by both hosts, so never request local or insecure URLs. */
export function readingFaviconUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid site icon URL.');
	let url: URL;
	try { url = new URL(value.trim()); } catch { throw new Error('Invalid site icon URL.'); }
	const host = url.hostname.toLowerCase();
	if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.')
		|| host.includes(':') || /^[\d.]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)$/.test(host)) {
		throw new Error('Invalid site icon URL.');
	}
	url.hash = '';
	return url.href;
}

/** Keep query parameters and their order: they may identify different articles. */
export function readingUrlIdentity(value: string): string {
	const url = new URL(readingUrl(value));
	url.hash = '';
	return url.href;
}

export function readingTimestamp(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
		|| !Number.isFinite(Date.parse(value))) throw new Error('Saved date must include a time and timezone.');
	const [year, month, day] = value.slice(0, 10).split('-').map(Number);
	const lastDay = new Date(Date.UTC(year!, month, 0)).getUTCDate();
	if (day! > lastDay) throw new Error('Saved date is not a calendar date.');
	return new Date(value).toISOString();
}

export function validateReadingMetadata(value: Record<string, unknown>): ReadingMetadata {
	if (value.crate_reading_version !== 1) throw new Error('Unsupported reading note version.');
	if (typeof value.crate_reading_id !== 'string' || !UUID.test(value.crate_reading_id)) throw new Error('Reading note needs a valid ID.');
	if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 1000) throw new Error('Reading note needs a title of at most 1,000 characters.');
	if (value.reading_status !== 'inbox' && value.reading_status !== 'archived') throw new Error('Reading status must be inbox or archived.');
	if (typeof value.favorite !== 'boolean') throw new Error('Favorite must be true or false.');
	if (!Array.isArray(value.tags) || value.tags.length > 50 || value.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 100)) throw new Error('Use up to 50 text tags of at most 100 characters.');
	if (value.extraction_status !== 'pending' && value.extraction_status !== 'ready' && value.extraction_status !== 'unavailable') throw new Error('Invalid extraction status.');
	if (value.capture_method !== undefined && value.capture_method !== 'url' && value.capture_method !== 'web-clipper') throw new Error('Invalid capture method.');
	if (value.author !== undefined && (typeof value.author !== 'string' || value.author.length > 1000)) throw new Error('Invalid author.');
	return {
		crate_reading_version: 1, crate_reading_id: value.crate_reading_id.toLowerCase(), title: value.title,
		source_url: readingUrl(value.source_url), saved_at: readingTimestamp(value.saved_at),
		reading_status: value.reading_status, favorite: value.favorite,
		tags: value.tags as string[], extraction_status: value.extraction_status,
		...(value.capture_method === undefined ? {} : { capture_method: value.capture_method }),
		...(value.author === undefined ? {} : { author: value.author }),
		...(value.resolved_url === undefined ? {} : { resolved_url: readingUrl(value.resolved_url) }),
		...(value.favicon_url === undefined ? {} : { favicon_url: readingFaviconUrl(value.favicon_url) }),
	};
}
