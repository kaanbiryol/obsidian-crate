import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { adoptReadingClip, createReadingNote, parseReadingNote, readingImportId, recordMarkdownHighlights, updateReadingNote } from './notes';
import { readingFaviconUrl, readingUrl, readingUrlIdentity } from './model';
import { validateReadingFolder } from '../settings';
import { readReadingFrontmatter } from './frontmatter';
import { readingDocument } from './markdown';

const savedAt = '2026-09-21T12:00:00Z';
const id = 'c700b5b4-006c-4d2a-8efb-a99b838d9224';
const note = () => createReadingNote({ id, url: 'https://example.com/read?a=1#section', savedAt: '2026-09-21T12:00:00Z' });
const clip = (body = '\n# A captured excerpt\n\n==My highlight==\n') => `---\ncrate_reading_import: web-clipper-v1\ntitle: Article\nsource_url: https://example.com\nsaved_at: 2026-09-21T14:00:00+02:00\ncustom: { "preserve": 'exactly' } # user comment\n---\n${body}`;

describe('reading Markdown', () => {
	it('records markers typed in Obsidian with deterministic IDs and keeps stored annotations', async () => {
		const note = createReadingNote({ id: '00000000-0000-4000-8000-000000000001', url: 'https://example.com', savedAt: '2026-09-21T12:00:00Z' });
		const article = note.replace('<!-- crate:article:end -->', 'Hello world. Second line.\n<!-- crate:article:end -->');
		const text = readingDocument(readReadingFrontmatter(article)!.body).text, at = (excerpt: string) => ({ start: text.indexOf(excerpt), end: text.indexOf(excerpt) + excerpt.length, text: excerpt });
		const noted = updateReadingNote(article, '00000000-0000-4000-8000-000000000001',
			{ highlights: [{ ...at('world'), note: 'Keep' }, { ...at('Second'), note: 'Removed' }] });
		const edited = noted.replace('==Second== line.', 'Second ==line==.');
		const recorded = await recordMarkdownHighlights(edited);
		expect(readReadingFrontmatter(recorded)!.body).toBe(readReadingFrontmatter(edited)!.body);
		expect(await recordMarkdownHighlights(edited)).toBe(recorded);
		expect(await recordMarkdownHighlights(recorded)).toBe(recorded);
		const metadata = parseReadingNote(recorded)!;
		expect(metadata.highlights?.map(({ text, note }) => ({ text, note }))).toEqual([{ text: 'world', note: 'Keep' }, { text: 'line', note: undefined }]);
		const manual = metadata.highlights![1]!;
		expect(manual.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(manual.createdAt).toBeUndefined();
		expect(metadata.highlight_recovery?.map(highlight => highlight.note)).toEqual(['Removed']);
		expect(await recordMarkdownHighlights(note)).toBe(note);
	});

	it('imports default Clipper properties without a Crate template', async () => {
		const body = '\n# Saved selection\n\n==Highlight==\n\nMy additions.\n';
		const source = '---\ntitle: A clip\nsource: https://example.com/article\nauthor: ["[[Alex]]", "[[Sam]]"]\ncreated: 2026-09-20\ntags: [clippings]\ncustom: { keep: true } # unchanged\n---\n' + body;
		const adopted = await adoptReadingClip(source, 'Reading/A clip.md', savedAt);
		expect(parseReadingNote(adopted)).toMatchObject({ title: 'A clip', source_url: 'https://example.com/article', author: '[[Alex]], [[Sam]]',
			reading_status: 'inbox', favorite: false, tags: ['clippings'], extraction_status: 'ready', capture_method: 'web-clipper' });
		expect(readReadingFrontmatter(adopted)?.body).toBe(body);
		expect(adopted).toContain('source: https://example.com/article\n');
		expect(adopted).toContain('custom: { keep: true } # unchanged\n');
		expect(await adoptReadingClip(adopted, 'Reading/Renamed.md', '2026-09-26T00:00:00Z')).toBe(adopted);
	});
	it.each(['# Plain note\n', '', '\uFEFF# Windows\r\n\r\nText\r\n', '---\n---\nText', '---\n# Just a comment\n---\nText'])('imports notes without properties while preserving their body: %j', async source => {
		const body = readReadingFrontmatter(source)?.body ?? source.replace(/^\uFEFF/, '');
		const adopted = await adoptReadingClip(source, 'Reading/Nested/My note.md', savedAt);
		expect(readReadingFrontmatter(adopted)?.body).toBe(body);
		expect(parseReadingNote(adopted)).toMatchObject({ title: 'My note', source_url: '', saved_at: '2026-09-21T12:00:00.000Z', favorite: false, reading_status: 'inbox' });
		const metadata = parseReadingNote(adopted)!;
		expect(parseReadingNote(updateReadingNote(adopted, metadata.crate_reading_id, { favorite: true, reading_status: 'archived' }))).toMatchObject({ favorite: true, reading_status: 'archived' });
		expect(await adoptReadingClip(source, 'Reading/Nested/My note.md', savedAt)).toBe(adopted);
	});
	it('keeps URL captures strict and refuses malformed import properties', async () => {
		expect(() => parseReadingNote(note().replace('https://example.com/read?a=1#section', ''))).toThrow();
		for (const yaml of ['source: javascript:alert(1)', 'source: https://user:secret@example.com', 'favorite: maybe', 'title: One\ntitle: Two', 'crate_reading_version: 2']) {
			await expect(adoptReadingClip(`---\n${yaml}\n---\nBody`, 'Reading/Bad.md', savedAt)).rejects.toThrow();
		}
	});
	it('round trips safe frontmatter without letting a title add properties', () => {
		const title = 'Title\n---\nfavorite: true\n<script>alert(1)</script>';
		const markdown = createReadingNote({ id, url: 'https://example.com', title, savedAt: '2026-09-21T12:00:00Z' });
		expect(parseReadingNote(markdown)).toMatchObject({ title, favorite: false, reading_status: 'inbox', extraction_status: 'pending' });
	});
	it('preserves unknown YAML, formatting, and every body byte during metadata edits', () => {
		fc.assert(fc.property(fc.string(), body => {
			const source = note().replace('\n---\n', '\nuser: { keep: \'spacing\' } # comment\n---\n') + body;
			const changed = updateReadingNote(source, id, { favorite: true, tags: ['one', 'two: three'] });
			expect(changed.slice(changed.indexOf('\n---\n'))).toBe(source.slice(source.indexOf('\n---\n')));
			expect(changed).toContain("user: { keep: 'spacing' } # comment");
			expect(parseReadingNote(changed)).toMatchObject({ favorite: true, tags: ['one', 'two: three'] });
		}));
	});
	it('handles CRLF and block lists without consuming the next property', () => {
		const source = note().replace('tags: []', 'tags:\n  - old\n  - tag').replace(/\n/g, '\r\n');
		const changed = updateReadingNote(source, id, { tags: ['new'], reading_status: 'archived' });
		expect(parseReadingNote(changed)).toMatchObject({ tags: ['new'], extraction_status: 'pending', reading_status: 'archived' });
		expect(changed).not.toMatch(/(?<!\r)\n/);
	});
	it('retains indented and quoted properties during adoption', async () => {
		const source = clip().replace(/^(crate_reading_import|title|source_url|saved_at|custom):/gm, '  "$1":');
		const result = await adoptReadingClip(source, 'Reading/Indented.md', savedAt);
		expect(parseReadingNote(result)).toMatchObject({ title: 'Article', capture_method: 'web-clipper' });
		expect(result).toContain('  "custom": { "preserve": \'exactly\' } # user comment');
	});
	it('rejects impossible calendar dates', () => {
		expect(() => createReadingNote({ id, url: 'https://example.com', savedAt: '2026-02-31T12:00:00Z' })).toThrow('calendar');
	});
	it('adopts legacy marked clips and keeps captured content and filenames independent of identity', async () => {
		const source = clip();
		const adopted = await adoptReadingClip(source, 'Reading/Article.md', savedAt);
		expect(await adoptReadingClip(adopted, 'Reading/Renamed.md', savedAt)).toBe(adopted);
		expect(adopted.endsWith('\n# A captured excerpt\n\n==My highlight==\n')).toBe(true);
		expect(adopted).toContain('custom: { "preserve": \'exactly\' } # user comment');
		expect(parseReadingNote(adopted)).toMatchObject({ capture_method: 'web-clipper', saved_at: '2026-09-21T12:00:00.000Z', extraction_status: 'ready' });
		expect(parseReadingNote(await adoptReadingClip('# My ordinary note', 'Reading/Mine.md', savedAt))).toMatchObject({ title: 'Mine', source_url: '' });
		expect(await adoptReadingClip(source, 'Reading/Article.md', savedAt)).toBe(adopted);
		expect(await readingImportId('Reading/Other.md', source)).not.toBe(parseReadingNote(adopted)?.crate_reading_id);
	});
	it('retains explicit user choices while filling import defaults', async () => {
		const source = clip('').replace('custom:', 'favorite: true\nreading_status: archived\ntags: [personal]\ncustom:');
		expect(parseReadingNote(await adoptReadingClip(source, 'Reading/Empty.md', savedAt))).toMatchObject({ favorite: true, reading_status: 'archived', tags: ['personal'], extraction_status: 'unavailable' });
	});
	it('refuses ambiguous or future properties and wrong identities without rewriting', () => {
		for (const source of [note().replace('favorite: false', 'favorite: false\nfavorite: true'), note().replace('tags: []', 'tags: &tags [x]\ncustom: *tags'), note().replace('crate_reading_version: 1', 'crate_reading_version: 2')]) expect(() => updateReadingNote(source, id, { favorite: true })).toThrow();
		expect(() => updateReadingNote(note(), crypto.randomUUID(), { favorite: true })).toThrow('changed');
	});
	it('does not coerce lists into status values', () => {
		for (const [from, to] of [['reading_status: "inbox"', 'reading_status: [inbox]'], ['extraction_status: "pending"', 'extraction_status: [pending]']]) {
			expect(() => parseReadingNote(note().replace(from!, to!))).toThrow();
		}
	});
	it('keeps URL query identity and rejects credentials and non-web protocols', () => {
		expect(readingUrlIdentity('HTTPS://EXAMPLE.com:443/read?a=2&a=1#part')).toBe('https://example.com/read?a=2&a=1');
		for (const url of ['javascript:alert(1)', 'file:///tmp/test', 'https://user:secret@example.com', 'example.com']) expect(() => readingUrl(url)).toThrow();
	});
	it('round trips an optional safe favicon URL while keeping older notes valid', () => {
		expect(parseReadingNote(note())?.favicon_url).toBeUndefined();
		const withIcon = note().replace('extraction_status: "pending"', 'extraction_status: "pending"\nfavicon_url: "https://cdn.example.com/icon.png#fragment"');
		expect(parseReadingNote(withIcon)?.favicon_url).toBe('https://cdn.example.com/icon.png');
		for (const url of ['http://example.com/icon.ico', 'https://localhost/icon.ico', 'https://127.0.0.1/icon.ico', 'https://user:password@example.com/icon.ico', 'data:image/png,AAA']) {
			expect(() => readingFaviconUrl(url)).toThrow('icon URL');
		}
	});
	it('rejects overlapping, hidden and non-portable folders', () => {
		for (const folder of ['../Reading', '/Reading', 'Reading//One', '.hidden/Reading', 'Reading/CON', 'Reminders/Sub', 'reminders', 'Tasks']) expect(() => validateReadingFolder(folder, folder === 'Tasks' ? 'Tasks/Reminders' : 'Reminders')).toThrow();
		expect(validateReadingFolder('Articles/Reading', 'Reminders')).toBe('Articles/Reading');
	});
});
