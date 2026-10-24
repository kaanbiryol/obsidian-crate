import { getPortablePathIssue, getSyncPathIssue, portablePathKey } from '@/protocol/portable-path';
import { readingSource } from './reading-presentation';

/** What a Reading note is named after. Without one, the note gets a generic name. */
export interface ReadingNameSource { title: string; url: string }

const MAX_SITE_BYTES = 64;
// A portable 255-byte name holds "Article ", two " - " separators, a full UUID and ".md".
const MAX_LABEL_BYTES = 255 - 8 - 3 - 3 - 32 - 3;

function clean(text: string, maxBytes: number): string {
	// eslint-disable-next-line no-control-regex -- Filenames cannot contain control characters.
	const value = text.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*#[\]^]/gu, ' ').replace(/\s+/gu, ' ').trim();
	let result = '';
	for (const character of value) {
		if (new TextEncoder().encode(result + character).length > maxBytes) break;
		result += character;
	}
	return result.replace(/^[. ]+|[. ]+$/gu, '');
}

/** `Title - site - id`, or `site - id` while the title is still the link's hostname. */
function readingCaptureName(source: ReadingNameSource | null, hex: string): string {
	let label = 'Article';
	if (source) {
		const site = clean(readingSource(source.url), MAX_SITE_BYTES);
		const title = clean(source.title, Math.min(180, MAX_LABEL_BYTES - new TextEncoder().encode(site).length));
		const untitled = !title || [site, new URL(source.url).hostname].some(value => portablePathKey(value) === portablePathKey(title));
		label = (untitled ? site : site ? `${title} - ${site}` : title) || 'Article';
	}
	const name = `${label} - ${hex}.md`;
	return getPortablePathIssue(name) ? `Article ${name}` : name;
}

function readingHex(id: string): string {
	const hex = id.replace(/-/g, '').toLowerCase();
	if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('Invalid Reading ID.');
	return hex;
}

export async function readingCapturePath(folder: string, source: ReadingNameSource | null, id: string, occupied: (path: string) => boolean | Promise<boolean>): Promise<string> {
	const hex = readingHex(id);
	for (let length = 8; length <= 32; length += 4) {
		const path = `${folder}/${readingCaptureName(source, hex.slice(0, length))}`;
		if (getSyncPathIssue(path)) throw new Error('The Reading folder path is too long.');
		if (!await occupied(path)) return path;
	}
	throw new Error('A file already uses this Reading ID. Your saved link has been preserved.');
}

/** True while `path` keeps the name Crate generated from `source`; a user rename is never replaced. */
export function isGeneratedCapturePath(path: string, folder: string, source: ReadingNameSource, id: string): boolean {
	const hex = readingHex(id), slash = path.lastIndexOf('/');
	if (portablePathKey(path.slice(0, slash)) !== portablePathKey(folder)) return false;
	for (let length = 8; length <= 32; length += 4) if (path.slice(slash + 1) === readingCaptureName(source, hex.slice(0, length))) return true;
	return false;
}
