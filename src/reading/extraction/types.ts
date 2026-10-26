export interface CapturedArticle {
	markdown: string;
	title?: string;
	author?: string;
	faviconUrl?: string;
	transcript?: { source: 'youtube'; language?: string };
}

export function transcriptMetadata(article: CapturedArticle): Record<string, string> {
	return article.transcript ? { transcript_source: article.transcript.source,
		...(article.transcript.language ? { transcript_language: article.transcript.language } : {}) } : {};
}
