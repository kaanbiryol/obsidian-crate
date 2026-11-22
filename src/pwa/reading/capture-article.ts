import type { CapturedArticle } from '@/reading/core/article';
import { readingImageFormat } from '@/reading/core/article-images';

/** Image bytes the server downloaded with an article, for an encrypted vault to save itself. */
interface ServerArticleImage { url: string; bytes: Uint8Array<ArrayBuffer> }
export type ServerCapturedArticle = CapturedArticle & { images?: ServerArticleImage[] };
const MAX_IMAGES = 10, MAX_IMAGE_BYTES = 2 * 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Only well-formed raster images within the limits; anything else keeps its web link. */
function serverImages(value: unknown): ServerArticleImage[] {
	if (!Array.isArray(value)) return [];
	const images: ServerArticleImage[] = [];
	let total = 0;
	for (const entry of value.slice(0, MAX_IMAGES) as unknown[]) {
		const { url, data } = (entry ?? {}) as { url?: unknown; data?: unknown };
		if (typeof url !== 'string' || !url.startsWith('https://') || typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) continue;
		let bytes: Uint8Array<ArrayBuffer>;
		try { bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0)); } catch { continue; }
		if (bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_TOTAL_BYTES || !readingImageFormat(bytes)) continue;
		total += bytes.length;
		images.push({ url, bytes });
	}
	return images;
}

const text = (value: unknown) => value === undefined || typeof value === 'string';

/** Browsers cannot read most sites across origins, so the server downloads the page
 * without storing the link. The article is encrypted on this device before upload. */
export async function captureServerArticle(url: string, request: (body: string) => Promise<Response>, { images: wanted = true } = {}): Promise<ServerCapturedArticle> {
	const response = await request(JSON.stringify(wanted ? { url } : { url, images: false }));
	if (!response.ok) throw new Error('Article download unavailable.');
	const answer = (await response.json()) as { article?: unknown; images?: unknown };
	const article = answer.article as Record<string, unknown> | undefined;
	const images = serverImages(answer.images);
	const transcript = article?.transcript as Record<string, unknown> | undefined;
	if (!article || typeof article.markdown !== 'string' || ![article.title, article.author, article.faviconUrl].every(text)
		|| (transcript !== undefined && (transcript?.source !== 'youtube' || !text(transcript.language)))) throw new Error('Article download unavailable.');
	return { markdown: article.markdown,
		...(article.title ? { title: article.title as string } : {}), ...(article.author ? { author: article.author as string } : {}),
		...(article.faviconUrl ? { faviconUrl: article.faviconUrl as string } : {}),
		...(transcript ? { transcript: { source: 'youtube' as const, ...(transcript.language ? { language: transcript.language as string } : {}) } } : {}),
		...(images.length ? { images } : {}) };
}
