import { describe, expect, it } from 'vitest';
import { isReadingArticle, isReadingItem, parseReadingListPage } from './record-validation';

const id = '00000000-0000-4000-8000-000000000001';
const item = (path = 'Reading/Article.md') => ({
	crate_reading_version: 1, crate_reading_id: id, title: 'Article', source_url: 'https://example.com/article',
	saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', path,
});

describe('reading record validation', () => {
	it('accepts items in the enrolled folder and rejects paths outside it', () => {
		expect(isReadingItem(item(), 'Reading')).toBe(true);
		expect(isReadingItem(item(''), 'Reading')).toBe(true);
		for (const path of ['Private/Article.md', 'Reading/../Private/Article.md', 'ReadingArchive/Article.md']) {
			expect(isReadingItem(item(path), 'Reading'), path).toBe(false);
		}
		expect(isReadingItem({ ...item(), reading_status: 'deleted' }, 'Reading')).toBe(false);
	});

	it('rejects a whole page when one item, issue or cursor is malformed', () => {
		const page = { items: [item()], issues: [{ path: 'Reading/Damaged.md', message: 'Unreadable' }], cursor: 'next' };
		expect(parseReadingListPage(page, 'Reading')).toMatchObject({ cursor: 'next', items: [{ path: 'Reading/Article.md' }] });
		expect(parseReadingListPage({ ...page, items: [item(), item('Private/Article.md')] }, 'Reading')).toBeNull();
		expect(parseReadingListPage({ ...page, issues: [{ path: 'Reading/Damaged.md' }] }, 'Reading')).toBeNull();
		for (const cursor of ['', 'x'.repeat(4097), 1, undefined]) {
			expect(parseReadingListPage({ ...page, cursor }, 'Reading'), String(cursor)).toBeNull();
		}
	});

	it('matches an article to the requested reading id', () => {
		const article = { item: item(), markdown: 'Body' };
		expect(isReadingArticle(article, 'Reading', id)).toBe(true);
		expect(isReadingArticle(article, 'Reading', '00000000-0000-4000-8000-000000000002')).toBe(false);
		expect(isReadingArticle({ ...article, markdown: undefined }, 'Reading')).toBe(false);
	});
});
