import { describe, expect, it } from 'vitest';
import { applyLocalArticle, assembleReadingArticle, managedArticle } from './article';
import { ARTICLE_END, ARTICLE_START, MAX_READING_BYTES } from './model';
import { createReadingNote, parseReadingNote } from './notes';
import { patchReadingFrontmatter, readReadingFrontmatter } from './frontmatter';

const note = () => createReadingNote({
	id: 'c700b5b4-006c-4d2a-8efb-a99b838d9224', url: 'https://example.com/article', savedAt: '2026-10-01T12:00:00Z',
});

describe('Reading article assembly', () => {
	it.each(['capture', 'extraction', 'local'] as const)('preserves unowned bytes while enriching a %s', kind => {
		const source = '\uFEFF' + note().replace('tags: []', "tags: [kept]\ncustom: { keep: 'spacing' } # comment")
			.replace(/\n/g, '\r\n') + '\r\nMy personal notes.\r\n';
		const article = { markdown: '# Extracted\n\nArticle text.', title: 'Article', author: 'Writer',
			faviconUrl: 'https://example.com/favicon.ico', transcript: { source: 'youtube' as const, language: 'en' } };
		const { content, title } = assembleReadingArticle(source, parseReadingNote(source)!, {
			kind, article, block: managedArticle(source)!,
		});
		expect(title).toBe('Article');
		expect(parseReadingNote(content)).toMatchObject({ title: 'Article', author: 'Writer', tags: ['kept'],
			favicon_url: 'https://example.com/favicon.ico', transcript_source: 'youtube', transcript_language: 'en', extraction_status: 'ready' });
		expect(content.startsWith('\uFEFF---\r\n')).toBe(true);
		expect(content).toContain("custom: { keep: 'spacing' } # comment\r\n");
		expect(content.slice(content.indexOf(ARTICLE_START))).toBe(
			`${ARTICLE_START}\n\n# Extracted\n\nArticle text.\n\n${ARTICLE_END}\r\n\r\nMy personal notes.\r\n`,
		);
		expect(content).toContain('transcript_source: "youtube"\r\ntranscript_language: "en"\r\nauthor: "Writer"\r\nfavicon_url: "https://example.com/favicon.ico"\r\n---');
	});

	it.each(['capture', 'extraction', 'local'] as const)('retains an authored title and applies the %s author/icon policy', kind => {
		const source = patchReadingFrontmatter(note(), { title: 'My title', author: 'My author', favicon_url: 'https://example.com/mine.ico' });
		const { content, title } = assembleReadingArticle(source, parseReadingNote(source)!, { kind, block: managedArticle(source)!,
			article: { markdown: 'Article', title: 'Extracted title', author: 'Extracted author', faviconUrl: 'https://example.com/new.ico' } });
		expect(title).toBe('My title');
		expect(parseReadingNote(content)).toMatchObject({ title: 'My title',
			author: kind === 'capture' ? 'Extracted author' : 'My author',
			favicon_url: kind === 'capture' ? 'https://example.com/new.ico' : 'https://example.com/mine.ico' });
	});

	it.each(['capture', 'extraction', 'local'] as const)('preserves the existing %s handling of blank and padded titles', kind => {
		const source = note(), metadata = parseReadingNote(source)!, block = managedArticle(source)!;
		for (const title of ['', '   ', '  An article  ']) {
			const result = assembleReadingArticle(source, metadata, { kind, block, article: { markdown: 'Article', title } });
			const expected = title === '' || kind === 'capture' && title.trim() === '' ? 'example.com' : title;
			expect(result.title).toBe(expected);
			expect(readReadingFrontmatter(result.content)?.value.title).toBe(expected);
		}
	});

	it.each(['capture', 'extraction'] as const)('keeps existing body and metadata when a %s has no article', kind => {
		const source = patchReadingFrontmatter(note(), { transcript_source: 'youtube', transcript_language: 'de', resolved_url: 'https://example.com/previous' })
			.replace('title: "example.com"', "title: 'example.com' # original spelling")
			.replace(ARTICLE_END, `Existing managed text.\n${ARTICLE_END}`) + '\nPersonal text.\n';
		const { content } = assembleReadingArticle(source, parseReadingNote(source)!, {
			kind, block: managedArticle(source)!, article: null, resolvedUrl: 'https://example.com/new',
		});
		const expected = source.replace('extraction_status: "pending"', 'extraction_status: "unavailable"');
		expect(content).toBe(kind === 'capture' ? expected.replace("title: 'example.com' # original spelling", 'title: "example.com"') : expected);
		expect(parseReadingNote(content)).toMatchObject({ transcript_source: 'youtube', transcript_language: 'de', resolved_url: 'https://example.com/previous' });
	});

	it.each(['capture', 'extraction'] as const)('stores resolved URLs and retains transcript language for a %s', kind => {
		const source = patchReadingFrontmatter(note(), { transcript_source: 'youtube', transcript_language: 'de' });
		const { content } = assembleReadingArticle(source, parseReadingNote(source)!, { kind, block: managedArticle(source)!,
			article: { markdown: 'Transcript', transcript: { source: 'youtube' } }, resolvedUrl: 'https://example.com/final' });
		expect(parseReadingNote(content)).toMatchObject({ transcript_source: 'youtube', transcript_language: 'de', resolved_url: 'https://example.com/final' });
	});

	it('marks an empty video ready in every publication', () => {
		const source = note(), metadata = parseReadingNote(source)!;
		const article = { markdown: '', title: 'Video' };
		const local = applyLocalArticle(source, { ...metadata, path: 'Reading/Video.md' }, article);
		expect(parseReadingNote(local)?.extraction_status).toBe('ready');
		for (const kind of ['capture', 'extraction'] as const) {
			const { content } = assembleReadingArticle(source, metadata, { kind, block: managedArticle(source)!, article });
			expect(parseReadingNote(content)?.extraction_status).toBe('ready');
		}
	});

	it('keeps size validation at the existing publication boundary', () => {
		const source = note(), metadata = parseReadingNote(source)!, block = managedArticle(source)!;
		const article = { markdown: 'é'.repeat(MAX_READING_BYTES / 2) };
		expect(() => assembleReadingArticle(source, metadata, { kind: 'extraction', article, block })).toThrow('Reading note is larger than 1 MB.');
		expect(() => applyLocalArticle(source, { ...metadata, path: 'Reading/Article.md' }, article)).toThrow('Reading note is larger than 1 MB.');
		// Capture extraction bounds article size before assembly; its initial note is
		// patched before inserting text. Keep that boundary unchanged in this refactor.
		const captured = assembleReadingArticle(source, metadata, { kind: 'capture', article });
		expect(new TextEncoder().encode(captured.content).byteLength).toBeGreaterThan(MAX_READING_BYTES);
	});

	it('checks local source eligibility before assembling an oversized article', () => {
		const source = note().replace(ARTICLE_END, `My authored article.\n${ARTICLE_END}`);
		expect(() => applyLocalArticle(source, { ...parseReadingNote(source)!, path: 'Reading/Article.md' }, {
			markdown: 'x'.repeat(MAX_READING_BYTES),
		})).toThrow('The reading note changed. Its current contents have been kept.');
	});
});
