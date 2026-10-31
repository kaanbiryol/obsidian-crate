import { describe, expect, it } from 'vitest';
import { adoptReadingClip, parseReadingNote, recordMarkdownHighlights } from './notes';
import { readReadingFrontmatter } from './frontmatter';

const savedAt = '2026-09-21T12:00:00Z';
const exported = (entries: unknown) => `<!-- crate:clipper-highlights ${typeof entries === 'string' ? entries : JSON.stringify(entries)} -->`;
const clip = (body: string, entries: unknown) => `---\ntitle: Article\nsource: https://example.com/a\n---\n${body}\n\n${exported(entries)}\n`;
const adopt = (markdown: string) => adoptReadingClip(markdown, 'Reading/Article.md', savedAt);
const body = (markdown: string) => readReadingFrontmatter(markdown)!.body;

describe('Web Clipper highlight import', () => {
	it('keeps dates and notes on inline markers and removes the export', async () => {
		const adopted = await adopt(clip('First ==quoted **passage**== here.\n\nThen ==another== one.', [
			{ text: 'quoted **passage**', timestamp: '2026-09-20T10:00:00.000Z', notes: ['Why it matters', 'Second thought'] },
			{ text: 'another', timestamp: '2026-09-20T10:05:00.000Z' },
		]));
		expect(body(adopted)).toBe('First ==quoted **passage**== here.\n\nThen ==another== one.\n\n');
		expect(parseReadingNote(adopted)!.highlights).toMatchObject([
			{ text: 'quoted passage', createdAt: '2026-09-20T10:00:00.000Z', note: 'Why it matters\n\nSecond thought' },
			{ text: 'another', createdAt: '2026-09-20T10:05:00.000Z' },
		]);
		expect(parseReadingNote(adopted)!.highlights!.every(highlight => !highlight.id!.startsWith('markdown-'))).toBe(true);
		expect(await adopt(clip('First ==quoted **passage**== here.\n\nThen ==another== one.', [
			{ text: 'quoted **passage**', timestamp: '2026-09-20T10:00:00.000Z', notes: ['Why it matters', 'Second thought'] },
			{ text: 'another', timestamp: '2026-09-20T10:05:00.000Z' },
		]))).toBe(adopted);
	});

	it('adds markers when the clip has none and splits selections across blocks', async () => {
		const adopted = await adopt(clip('One paragraph.\n\nTwo paragraph.', [{ text: 'One paragraph.\n\nTwo', timestamp: '2026-09-20T10:00:00Z', notes: ['Both'] }]));
		expect(body(adopted)).toBe('==One paragraph.==\n\n==Two== paragraph.\n\n');
		expect(parseReadingNote(adopted)!.highlights).toMatchObject([
			{ text: 'One paragraph.', note: 'Both', createdAt: '2026-09-20T10:00:00.000Z' },
			{ text: 'Two', createdAt: '2026-09-20T10:00:00.000Z' },
		]);
	});

	it('keeps repeated and missing excerpts in recovery instead of guessing', async () => {
		const adopted = await adopt(clip('Same text. Same text. ==Same text==.', [
			{ text: 'Same text', notes: ['Marked'] }, { text: 'Gone', notes: ['Kept'] }, { text: 'text. Same' },
		]));
		const item = parseReadingNote(adopted)!;
		expect(item.highlights).toMatchObject([{ text: 'Same text', note: 'Marked' }]);
		expect(item.highlight_recovery).toMatchObject([{ text: 'Gone', note: 'Kept' }, { text: 'text. Same' }]);
	});

	it('leaves unclaimed markers for the regular scan to record', async () => {
		const adopted = await adopt(clip('==Typed== and ==clipped==.', [{ text: 'clipped', timestamp: '2026-09-20T10:00:00Z' }]));
		const item = parseReadingNote(adopted)!;
		expect(item.highlights).toMatchObject([{ text: 'Typed' }, { text: 'clipped', createdAt: '2026-09-20T10:00:00.000Z' }]);
		expect(item.highlights![0]!.id).toMatch(/^markdown-/);
		const recorded = parseReadingNote(await recordMarkdownHighlights(adopted, item))!;
		expect(recorded.highlights!.map(highlight => highlight.id!.startsWith('markdown-'))).toEqual([false, false]);
		expect(recorded.highlights![1]).toEqual(item.highlights![1]);
	});

	it('removes an empty export and leaves malformed ones untouched', async () => {
		expect(body(await adopt(clip('Text.', '')))).toBe('Text.\n\n');
		for (const entries of ['[{"text":', '{"text":"Text"}']) {
			const adopted = await adopt(clip('Text.', entries));
			expect(body(adopted)).toBe(`Text.\n\n${exported(entries)}\n`);
			expect(parseReadingNote(adopted)!.highlights).toBeUndefined();
		}
	});
});
