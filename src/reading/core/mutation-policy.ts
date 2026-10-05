import { managedArticle } from './article';
import type { ReadingChanges, ReadingMetadata } from './model';

/** Check the same field preconditions in local, plaintext and encrypted writers. */
export function readingUpdateIssue(current: ReadingChanges, before: object, changes: object): 'unsupported' | 'conflict' | null {
	for (const field of Object.keys(changes)) {
		if (!['favorite', 'tags', 'reading_status', 'highlights'].includes(field)) return 'unsupported';
		const key = field as keyof ReadingChanges;
		if (JSON.stringify(current[key]) !== JSON.stringify((before as ReadingChanges)[key])) return 'conflict';
	}
	return null;
}

/** Fetch consent and host-specific status/identity guards belong to the caller. */
export function isEmptyReadingCapture(content: string, metadata: ReadingMetadata): boolean {
	const block = managedArticle(content);
	return metadata.capture_method === 'url' && block !== null && !block.text.trim();
}
