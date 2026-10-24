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

/** Assemble verified source text; callers retain source eligibility and publication guards. */
export function assembleReadingArticle(content: string, metadata: ReadingMetadata, publication: ArticlePublication): { content: string; title: string } {
  const { article } = publication;
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
