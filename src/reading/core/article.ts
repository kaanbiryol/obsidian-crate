import { youtubeVideoId } from './youtube';
import { ARTICLE_START, ARTICLE_END, MAX_READING_BYTES, type ReadingItem } from './model';
import { parseReadingNote } from './notes';
import { patchReadingFrontmatter } from './frontmatter';
import { transcriptMetadata, type CapturedArticle } from '../extraction/types';

export function managedArticle(content: string): { start: number; end: number; text: string } | null {
  const start = content.indexOf(ARTICLE_START), end = content.indexOf(ARTICLE_END);
  if (start < 0 || end < start || content.indexOf(ARTICLE_START, start + 1) >= 0 || content.indexOf(ARTICLE_END, end + 1) >= 0) return null;
  return { start: start + ARTICLE_START.length, end, text: content.slice(start + ARTICLE_START.length, end) };
}

/** Only enrich the empty bookmark that initiated the download; keep current metadata and personal notes. */
export function applyLocalArticle(content: string, item: ReadingItem, article: CapturedArticle): string {
  const metadata = parseReadingNote(content), block = managedArticle(content);
  if (metadata?.crate_reading_id !== item.crate_reading_id || metadata.source_url !== item.source_url
    || metadata.capture_method !== 'url' || !(['unavailable', 'pending'].includes(metadata.extraction_status) || youtubeVideoId(metadata.source_url)) || !block || block.text.trim()) {
    throw new Error('The reading note changed. Its current contents have been kept.');
  }
  let result = `${content.slice(0, block.start)}\n\n${article.markdown}\n\n${content.slice(block.end)}`;
  result = patchReadingFrontmatter(result, { extraction_status: article.deferTranscript && !article.markdown ? 'pending' : 'ready',
    ...transcriptMetadata(article),
    ...(article.title && metadata.title === new URL(metadata.source_url).hostname ? { title: article.title } : {}),
    ...(article.author && !metadata.author ? { author: article.author } : {}),
    ...(article.faviconUrl && !metadata.favicon_url ? { favicon_url: article.faviconUrl } : {}),
  });
  if (new TextEncoder().encode(result).length > MAX_READING_BYTES) throw new Error('The reading note exceeds the 1 MB limit.');
  return result;
}
