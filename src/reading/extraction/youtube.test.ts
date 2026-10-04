import { expect, it } from 'vitest';
import { youtubeMetadata } from './youtube';
import { createReadingNote, parseReadingNote } from '../core/notes';
import { patchReadingFrontmatter } from '../core/frontmatter';
import { applyLocalArticle } from '../core/article';

it('keeps inert title and channel metadata while discarding supplied HTML and images', () => {
	expect(youtubeMetadata(JSON.stringify({ type: 'video', title: ' A video & more ', author_name: ' A channel ', html: '<iframe src="https://evil.example"></iframe>', thumbnail_url: 'http://127.0.0.1/pixel' })))
		.toEqual({ markdown: '', title: 'A video & more', author: 'A channel' });
});
it.each(['null', '[]', '{}', '{', '{"type":"video","title":" "}', '{"type":"link","title":"Sign in"}'])('rejects unusable metadata %s', json => {
	expect(() => youtubeMetadata(json)).toThrow();
});
it('publishes metadata-only captures without changing timestamps, tags, or personal text', () => {
	const source = 'https://youtu.be/jNQXAC9IVRw?t=42#keep';
	const note = patchReadingFrontmatter(createReadingNote({ id: '67de6c50-c70c-4c85-93f2-a048d9f33b1a', url: source, savedAt: '2026-10-03T12:00:00Z' }), { extraction_status: 'unavailable', tags: ['learn'] }) + '\nMy personal notes.\n';
	const result = applyLocalArticle(note, { ...parseReadingNote(note)!, path: 'Reading/Video.md' }, youtubeMetadata('{"type":"video","title":"A video","author_name":"Channel"}'));
	expect(parseReadingNote(result)).toMatchObject({ source_url: source, title: 'A video', author: 'Channel', tags: ['learn'], extraction_status: 'ready' });
	expect(result).toContain('My personal notes.');
});

it('keeps encrypted browser metadata pending for a trusted device and permits a later transcript', () => {
  const source = 'https://youtu.be/jNQXAC9IVRw?t=42';
  const note = createReadingNote({ id: '67de6c50-c70c-4c85-93f2-a048d9f33b1a', url: source, savedAt: '2026-10-03T12:00:00Z' });
  const pending = applyLocalArticle(note, { ...parseReadingNote(note)!, path: 'Reading/Video.md' }, { title: 'A video', markdown: '', deferTranscript: true });
  expect(parseReadingNote(pending)).toMatchObject({ title: 'A video', extraction_status: 'pending' });
  const ready = applyLocalArticle(pending, { ...parseReadingNote(pending)!, path: 'Reading/Video.md' }, { markdown: '**0:42** · A saved passage.', transcript: { source: 'youtube', language: 'en' } });
  expect(parseReadingNote(ready)).toMatchObject({ title: 'A video', extraction_status: 'ready', transcript_source: 'youtube', transcript_language: 'en' });
  expect(ready).toContain('**0:42**');
  expect(() => applyLocalArticle(ready, { ...parseReadingNote(ready)!, path: 'Reading/Video.md' }, { markdown: 'Replace' })).toThrow('kept');
});
