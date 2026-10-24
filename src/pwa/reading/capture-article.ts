import type { CapturedArticle } from '@/reading/extraction/types';
import { youtubeVideoId } from '@/reading/core/youtube';

const text = (value: unknown) => value === undefined || typeof value === 'string';

/** Browsers cannot read most sites across origins, so the server downloads the page
 * without storing the link. The article is encrypted on this device before upload.
 * A failure leaves an encrypted bookmark for an unlocked Obsidian device. */
export async function captureServerArticle(url: string, request: (body: string) => Promise<Response>): Promise<CapturedArticle> {
  const response = await request(JSON.stringify({ url }));
  if (!response.ok) throw new Error('Article download unavailable.');
  const article = ((await response.json()) as { article?: unknown }).article as Record<string, unknown> | undefined;
  const transcript = article?.transcript as Record<string, unknown> | undefined;
  if (!article || typeof article.markdown !== 'string' || ![article.title, article.author, article.faviconUrl].every(text)
    || (transcript !== undefined && (transcript?.source !== 'youtube' || !text(transcript.language)))) throw new Error('Article download unavailable.');
  const captured: CapturedArticle = { markdown: article.markdown,
    ...(article.title ? { title: article.title as string } : {}), ...(article.author ? { author: article.author as string } : {}),
    ...(article.faviconUrl ? { faviconUrl: article.faviconUrl as string } : {}),
    ...(transcript ? { transcript: { source: 'youtube' as const, ...(transcript.language ? { language: transcript.language as string } : {}) } } : {}) };
  // A video without captions stays open for Obsidian to fetch its transcript later.
  return youtubeVideoId(url) && !captured.markdown ? { ...captured, deferTranscript: true } : captured;
}
