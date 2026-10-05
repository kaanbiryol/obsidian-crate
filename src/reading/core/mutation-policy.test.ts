import { expect, it } from 'vitest';
import { ARTICLE_START, ARTICLE_END } from './model';
import { createReadingNote, parseReadingNote } from './notes';
import { isEmptyReadingCapture, readingUpdateIssue } from './mutation-policy';

it('checks only edited fields, including absent highlights and ordered tag values', () => {
	const current = { favorite: true, tags: ['one', 'two'], reading_status: 'archived' as const };
	expect(readingUpdateIssue(current, { tags: ['one', 'two'] }, { tags: [] })).toBeNull();
	expect(readingUpdateIssue(current, {}, { highlights: [] })).toBeNull();
	expect(readingUpdateIssue(current, { tags: ['two', 'one'] }, { tags: [] })).toBe('conflict');
	expect(readingUpdateIssue(current, {}, { favorite: false })).toBe('conflict');
	expect(readingUpdateIssue(current, { favorite: false }, { favorite: true })).toBe('conflict');
	expect(readingUpdateIssue(current, {}, { source_url: 'https://other.example' })).toBe('unsupported');
});

it('allows fetching only an unambiguous empty URL capture block', () => {
	const note = createReadingNote({ id: 'c700b5b4-006c-4d2a-8efb-a99b838d9224', url: 'https://example.com', savedAt: '2026-09-21T12:00:00Z' });
	const metadata = parseReadingNote(note)!;
	expect(isEmptyReadingCapture(note + '\nPersonal notes outside the article.', metadata)).toBe(true);
	expect(isEmptyReadingCapture(note.replace(ARTICLE_START, ARTICLE_START + '\nMy article edits'), metadata)).toBe(false);
	expect(isEmptyReadingCapture(note.replace(ARTICLE_END, ''), metadata)).toBe(false);
	expect(isEmptyReadingCapture(note + ARTICLE_START + ARTICLE_END, metadata)).toBe(false);
	expect(isEmptyReadingCapture(note, { ...metadata, capture_method: 'web-clipper' })).toBe(false);
	expect(isEmptyReadingCapture(note, { ...metadata, capture_method: undefined })).toBe(false);
});
