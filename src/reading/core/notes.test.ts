import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { adoptReadingClip, createReadingNote, parseReadingNote, readingImportId, updateReadingNote } from './notes';
import { readingFaviconUrl, readingUrl, readingUrlIdentity } from './model';
import { validateReadingFolder } from '../settings';

const id = 'c700b5b4-006c-4d2a-8efb-a99b838d9224';
const note = () => createReadingNote({ id, url: 'https://example.com/read?a=1#section', savedAt: '2026-09-21T12:00:00Z' });
const clip = (body = '\n# A captured excerpt\n\n==My highlight==\n') => `---\ncrate_reading_import: web-clipper-v1\ntitle: Article\nsource_url: https://example.com\nsaved_at: 2026-09-21T14:00:00+02:00\ncustom: { "preserve": 'exactly' } # user comment\n---\n${body}`;

describe('reading Markdown', () => {
	it('round trips safe frontmatter without letting a title add properties', () => {
		const title = 'Title\n---\nfavorite: true\n<script>alert(1)</script>';
		const markdown = createReadingNote({ id, url: 'https://example.com', title, savedAt: '2026-09-21T12:00:00Z' });
		expect(parseReadingNote(markdown)).toMatchObject({ title, favorite: false, reading_status: 'inbox', extraction_status: 'pending' });
	});
	it('preserves unknown YAML, formatting, and every body byte during metadata edits', () => {
		fc.assert(fc.property(fc.string(), body => {
			const source = note().replace('\n---\n\n', '\nuser: { keep: \'spacing\' } # comment\n---\n\n') + body;
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
		const result = await adoptReadingClip(source, 'Reading/Indented.md');
		expect(parseReadingNote(result)).toMatchObject({ title: 'Article', capture_method: 'web-clipper' });
		expect(result).toContain('  "custom": { "preserve": \'exactly\' } # user comment');
	});
	it('rejects impossible calendar dates', () => {
		expect(() => createReadingNote({ id, url: 'https://example.com', savedAt: '2026-02-31T12:00:00Z' })).toThrow('calendar');
	});
	it('adopts only marked clips and keeps captured content and filenames independent of identity', async () => {
		const source = clip();
		const adopted = await adoptReadingClip(source, 'Reading/Article.md');
		expect(await adoptReadingClip(adopted, 'Reading/Renamed.md')).toBe(adopted);
		expect(adopted.endsWith('\n# A captured excerpt\n\n==My highlight==\n')).toBe(true);
		expect(adopted).toContain('custom: { "preserve": \'exactly\' } # user comment');
		expect(parseReadingNote(adopted)).toMatchObject({ capture_method: 'web-clipper', saved_at: '2026-09-21T12:00:00.000Z', extraction_status: 'ready' });
		expect(await adoptReadingClip('# My ordinary note', 'Reading/Mine.md')).toBe('# My ordinary note');
		expect(await adoptReadingClip(source, 'Reading/Article.md')).toBe(adopted);
		expect(await readingImportId('Reading/Other.md', source)).not.toBe(parseReadingNote(adopted)?.crate_reading_id);
	});
	it('retains explicit user choices while filling import defaults', async () => {
		const source = clip('').replace('custom:', 'favorite: true\nreading_status: archived\ntags: [personal]\ncustom:');
		expect(parseReadingNote(await adoptReadingClip(source, 'Reading/Empty.md'))).toMatchObject({ favorite: true, reading_status: 'archived', tags: ['personal'], extraction_status: 'unavailable' });
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
