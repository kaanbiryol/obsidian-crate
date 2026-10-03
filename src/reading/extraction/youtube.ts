import type { CapturedArticle } from './types';

export const YOUTUBE_METADATA_MAX_BYTES = 64 * 1024;

export function youtubeMetadataUrl(id: string): string {
	return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
}

/** Keep only inert metadata. oEmbed's player HTML and supplied image URLs are never rendered. */
export function youtubeMetadata(json: string): CapturedArticle {
	let value: unknown;
	try { value = JSON.parse(json); } catch { throw new Error('Video details are unavailable.'); }
	if (!value || typeof value !== 'object') throw new Error('Video details are unavailable.');
	const data = value as Record<string, unknown>;
	if (data.type !== 'video' || typeof data.title !== 'string' || !data.title.trim()) throw new Error('Video details are unavailable.');
	return { markdown: '', title: data.title.trim().slice(0, 1000),
		...(typeof data.author_name === 'string' && data.author_name.trim() ? { author: data.author_name.trim().slice(0, 1000) } : {}) };
}
