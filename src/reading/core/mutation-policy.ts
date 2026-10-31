import { managedArticle } from './article';
import { readReadingFrontmatter } from './frontmatter';
import type { ReadingChanges, ReadingMetadata } from './model';
import { sha256Hex } from '@/platform/sha256';
import { isSha256Hex } from '@/platform/validation';

/** Check the same field preconditions in local, plaintext and encrypted writers. */
export function readingUpdateIssue(current: ReadingChanges, before: object, changes: object): 'unsupported' | 'conflict' | null {
	for (const field of Object.keys(changes)) {
		if (!['favorite', 'tags', 'reading_status', 'highlights'].includes(field)) return 'unsupported';
		const key = field as keyof ReadingChanges;
		if (JSON.stringify(current[key]) !== JSON.stringify((before as ReadingChanges)[key])) return 'conflict';
	}
	return null;
}

/** A delete removes a note only while it is what the client showed: the library fields
 * in `before` and the article body whose SHA-256 is `markdownHash`, so edits made
 * elsewhere survive. Plaintext and encrypted writers check the same rule. */
export async function readingDeleteIssue(current: ReadingChanges, content: string, before: unknown, markdownHash: unknown): Promise<'invalid' | 'unsupported' | 'conflict' | null> {
	if (!before || typeof before !== 'object' || Array.isArray(before) || !Object.keys(before).length || !isSha256Hex(markdownHash)) return 'invalid';
	return readingUpdateIssue(current, before, before)
		?? (await sha256Hex(readReadingFrontmatter(content)?.body ?? '') === markdownHash ? null : 'conflict');
}

/** Fetch consent and host-specific status/identity guards belong to the caller. */
export function isEmptyReadingCapture(content: string, metadata: ReadingMetadata): boolean {
	const block = managedArticle(content);
	return metadata.capture_method === 'url' && block !== null && !block.text.trim();
}
