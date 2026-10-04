import { ARTICLE_START, ARTICLE_END, readingUrlIdentity, type ReadingItem } from './model';
import { managedArticle } from './article';
import { parseReadingNote } from './notes';
import { patchReadingFrontmatter, readReadingFrontmatter } from './frontmatter';
import { readMarkdownHighlights } from './markdown-highlights';
import { anchorHighlight } from './markdown-highlights';
import { readingDocument } from './markdown';

export function duplicateReadingGroups(items: ReadingItem[]): ReadingItem[][] {
	const groups = new Map<string, ReadingItem[]>();
	for (const item of items) {
		if (!item.source_url) continue;
		const identity = readingUrlIdentity(item.source_url), group = groups.get(identity) ?? [];
		group.push(item); groups.set(identity, group);
	}
	return [...groups.values()].filter(group => group.length > 1);
}

/** Copy a clip into an empty owned block. Neither original file is deleted.
 * Existing state and personal text belong to the destination, even if archived. */
export function enrichReadingBookmark(target: string, source: string): string {
	const item = parseReadingNote(target), clip = parseReadingNote(source), block = managedArticle(target);
	if (!item || !clip || item.crate_reading_id === clip.crate_reading_id || !item.source_url || !clip.source_url
		|| readingUrlIdentity(item.source_url) !== readingUrlIdentity(clip.source_url)
		|| item.capture_method !== 'url' || !block || block.text.trim() || clip.capture_method !== 'web-clipper') throw new Error('Only an empty bookmark for the same source can use clipped content.');
	const clipBody = readReadingFrontmatter(source)!.body;
	if (!clipBody.trim()) throw new Error('The clipped note has no content.');
	if (clipBody.includes(ARTICLE_START) || clipBody.includes(ARTICLE_END)) throw new Error('The clip contains managed article markers. Review it in Obsidian.');
	const result = target.slice(0, block.start) + '\n\n' + clipBody + '\n\n' + target.slice(block.end);
	const targetBody = readReadingFrontmatter(target)!.body;
	const anchors = [
		...(item.highlights ?? []).map(highlight => anchorHighlight(readingDocument(targetBody).text, highlight)),
		...(clip.highlights ?? []).map(highlight => anchorHighlight(readingDocument(clipBody).text, highlight)),
	];
	const mapped = readMarkdownHighlights(readReadingFrontmatter(result)!.body, anchors);
	const recovery = [...(item.highlight_recovery ?? []), ...(clip.highlight_recovery ?? []), ...mapped.recovery];
	return patchReadingFrontmatter(result, { extraction_status: 'ready',
		...(clip.transcript_source ? { transcript_source: clip.transcript_source } : {}),
		...(clip.transcript_language ? { transcript_language: clip.transcript_language } : {}),
		...(item.title === new URL(item.source_url).hostname ? { title: clip.title } : {}),
		...(!item.author && clip.author ? { author: clip.author } : {}),
		...(anchors.length || mapped.highlights.length ? { highlights: mapped.highlights, highlight_format: 'markdown-v1' } : {}),
		...(recovery.length ? { highlight_recovery: recovery } : {}),
	});
}
