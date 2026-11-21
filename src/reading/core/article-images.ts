import { Marked, type Token, type Tokens } from 'marked';
import type { ReadingImageMode } from '@/protocol/feature-policy';

export type { ReadingImageMode };
export const DEFAULT_READING_IMAGE_MODE: ReadingImageMode = 'save';
export function readingImageMode(value: unknown): ReadingImageMode {
	return value === 'remote' ? 'remote' : DEFAULT_READING_IMAGE_MODE;
}

/** Raster formats only: SVG can carry scripts. Identified by their bytes, not the server's type. */
const FORMATS: { extension: string; type: string; matches: (bytes: Uint8Array) => boolean }[] = [
	{ extension: 'png', type: 'image/png', matches: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
	{ extension: 'jpg', type: 'image/jpeg', matches: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ extension: 'gif', type: 'image/gif', matches: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
	{ extension: 'webp', type: 'image/webp', matches: b => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
	{ extension: 'avif', type: 'image/avif', matches: b => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')) },
];
function ascii(bytes: Uint8Array, at: number, text: string): boolean {
	for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
	return true;
}
export function readingImageFormat(bytes: Uint8Array): { extension: string; type: string } | null {
	const format = FORMATS.find(candidate => candidate.matches(bytes));
	return format ? { extension: format.extension, type: format.type } : null;
}
export function readingImageType(path: string): string | null {
	const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
	return FORMATS.find(format => format.extension === extension)?.type ?? null;
}

export interface ReadingImageLimits {
	/** Images downloaded per article; later ones keep their links. Unlimited when omitted. */
	count?: number;
	bytes: number;
	totalBytes: number;
}
/** On the device nothing limits how many images an article has; size keeps one page from filling the vault. */
const READING_IMAGE_LIMITS: ReadingImageLimits = { bytes: 10 * 1024 * 1024, totalBytes: 40 * 1024 * 1024 };

/** The folder an article's saved images live in, named by its stable Reading ID so renames keep links. */
export function readingImageFolder(folder: string, id: string): string {
	return `${folder}/attachments/${id.toLowerCase()}`;
}
/** True for a file inside some article's image folder. */
export function isReadingImagePath(folder: string, path: string): boolean {
	const prefix = `${folder}/attachments/`;
	if (!path.startsWith(prefix)) return false;
	const [id, name, ...rest] = path.slice(prefix.length).split('/');
	return !rest.length && Boolean(id && /^[0-9a-f-]{36}$/.test(id) && name && readingImageType(name));
}

export interface ReadingImageFile { url: string; path: string; bytes: Uint8Array; type: string }
/** Returns the body of a successful response, or null for anything that is not an image. */
export type ReadingImageFetch = (url: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array | null>;

const lexer = new Marked({ async: false, gfm: true });
/** Every Markdown image in document order, with its exact source text. */
function markdownImages(markdown: string): Tokens.Image[] {
	const images: Tokens.Image[] = [];
	void lexer.walkTokens(lexer.lexer(markdown), (token: Token) => { if (token.type === 'image') images.push(token as Tokens.Image); });
	return images;
}
function remoteImageUrl(href: string): string | null {
	try {
		const url = new URL(href);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
	} catch { return null; }
}
function escapeAlt(text: string): string { return text.replace(/[\\[\]]/g, '\\$&'); }

/**
 * Downloads an article's `https` images for `readingImageFolder`. An image that fails, is not a
 * supported raster format or is over a limit is left out and keeps its link. Nothing is stored.
 */
export async function downloadArticleImages(markdown: string, options: {
	folder: string; id: string; fetchImage: ReadingImageFetch; signal: AbortSignal; limits?: ReadingImageLimits; concurrency?: number;
}): Promise<ReadingImageFile[]> {
	const limits = options.limits ?? READING_IMAGE_LIMITS;
	const urls: string[] = [];
	for (const image of markdownImages(markdown)) {
		const url = remoteImageUrl(image.href);
		if (url && !urls.includes(url) && (limits.count === undefined || urls.length < limits.count)) urls.push(url);
	}
	const directory = readingImageFolder(options.folder, options.id);
	const files: ReadingImageFile[] = [];
	let total = 0, next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const index = next++, url = urls[index]!;
			options.signal.throwIfAborted();
			const bytes = await options.fetchImage(url, limits.bytes, options.signal).catch(() => null);
			options.signal.throwIfAborted();
			const format = bytes && bytes.length <= limits.bytes ? readingImageFormat(bytes) : null;
			if (!bytes || !format || total + bytes.length > limits.totalBytes) continue;
			total += bytes.length;
			files.push({ url, path: `${directory}/${index + 1}.${format.extension}`, bytes, type: format.type });
		}
	};
	await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, urls.length) }, worker));
	return files.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
}

/** Points each image `files` holds at its vault copy, relative to a note in `folder`. Other images keep their links. */
export function linkSavedImages(markdown: string, folder: string, files: Pick<ReadingImageFile, 'url' | 'path'>[]): string {
	if (!files.length) return markdown;
	const saved = new Map(files.map(file => [file.url, file.path]));
	// Rewrite each image's own source text in order, so equal text elsewhere is untouched.
	let result = '', cursor = 0;
	for (const image of markdownImages(markdown)) {
		const url = remoteImageUrl(image.href), path = url ? saved.get(url) : undefined;
		const at = markdown.indexOf(image.raw, cursor);
		if (!path || at < 0) continue;
		result += `${markdown.slice(cursor, at)}![${escapeAlt(image.text)}](${path.slice(folder.length + 1)})`;
		cursor = at + image.raw.length;
	}
	return result + markdown.slice(cursor);
}

/**
 * Where a rendered image comes from: a remote `https` link, a vault path resolved against the
 * note's folder, or nothing for any other scheme (data:, http:, file: and the like).
 */
export function readingImageSource(src: string, notePath: string): { kind: 'remote'; url: string } | { kind: 'vault'; path: string } | null {
	const remote = remoteImageUrl(src);
	if (remote) return { kind: 'remote', url: remote };
	if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) return null;
	let decoded: string;
	try { decoded = decodeURI(src.split(/[?#]/)[0]!); } catch { return null; }
	const segments = decoded.startsWith('/') ? [] : notePath.split('/').slice(0, -1);
	for (const segment of decoded.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') { if (!segments.length) return null; segments.pop(); } else segments.push(segment);
	}
	const path = segments.join('/');
	return path && readingImageType(path) ? { kind: 'vault', path } : null;
}

/** The vault images a note links to, each once, in document order. */
export function linkedVaultImages(markdown: string, notePath: string): string[] {
	const paths: string[] = [];
	for (const image of markdownImages(markdown)) {
		const source = readingImageSource(image.href, notePath);
		if (source?.kind === 'vault' && !paths.includes(source.path)) paths.push(source.path);
	}
	return paths;
}
