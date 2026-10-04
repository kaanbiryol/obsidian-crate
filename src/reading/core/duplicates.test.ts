import { expect, it } from 'vitest';
import { createReadingNote, adoptReadingClip, parseReadingNote, updateReadingNote } from './notes';
import { patchReadingFrontmatter } from './frontmatter';
import { enrichReadingBookmark } from './duplicates';

it('fills only the empty bookmark while preserving its identity, state, notes and clip annotations', async () => {
	const target = patchReadingFrontmatter(createReadingNote({ id: '67de6c50-c70c-4c85-93f2-a048d9f33b1a', url: 'https://youtu.be/jNQXAC9IVRw?t=42', savedAt: '2026-10-04T12:00:00Z' }), { favorite: true, tags: ['keep'], reading_status: 'archived' }) + '\nMy personal note.\n';
	const imported = await adoptReadingClip('---\ntitle: Clipped video\nsource: https://youtube.com/watch?v=jNQXAC9IVRw\n---\n## Transcript\n\n**0:42** · A ==useful== passage.\n', 'Reading/clip.md', '2026-10-04T12:00:00Z');
	const clip = updateReadingNote(imported, parseReadingNote(imported)!.crate_reading_id, { highlights: parseReadingNote(imported)!.highlights!.map(highlight => ({ ...highlight, note: 'Keep my annotation' })) });
	const result = enrichReadingBookmark(target, clip);
	expect(parseReadingNote(result)).toMatchObject({ crate_reading_id: parseReadingNote(target)!.crate_reading_id, title: 'Clipped video', favorite: true, tags: ['keep'], reading_status: 'archived', highlights: [expect.objectContaining({ text: 'useful', note: 'Keep my annotation' })] });
	expect(result).toContain('My personal note.');
	expect(() => enrichReadingBookmark(result, clip)).toThrow('empty bookmark');
	expect(clip).toContain('==useful==');
});
