export interface CapturedArticle {
  markdown: string;
  title?: string;
  author?: string;
  faviconUrl?: string;
  /** Encrypted browser capture may hand an empty video to an unlocked device. */
  deferTranscript?: true;
  transcript?: { source: 'youtube'; language?: string };
}

export function transcriptMetadata(article: CapturedArticle): Record<string, string> {
  return article.transcript ? { transcript_source: article.transcript.source,
    ...(article.transcript.language ? { transcript_language: article.transcript.language } : {}) } : {};
}
