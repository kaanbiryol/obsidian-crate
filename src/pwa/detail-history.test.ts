import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissProjectHistory, openProjectHistory } from './project-history';
import { dismissReadingArticleHistory, openReadingArticleHistory } from './reading/article-history';

interface Entry { state: unknown; url: string }
let entries: Entry[], index: number;
const current = () => entries[index]!;
const save = () => ({ ...current() });
const restore = (entry: Entry) => history.replaceState(entry.state, '', entry.url);

beforeEach(() => {
	entries = [{ state: null, url: 'https://crate.test/notifications' }]; index = 0;
	vi.stubGlobal('location', { get href() { return current().url; } });
	vi.stubGlobal('history', {
		get state() { return current().state; },
		replaceState(state: unknown, _unused: string, url: string | URL) {
			entries[index] = { state, url: new URL(url, current().url).href };
		},
		pushState(state: unknown, _unused: string, url: string | URL) {
			const next = { state, url: new URL(url, current().url).href };
			entries.splice(++index, entries.length, next);
		},
		back() { if (index > 0) index--; },
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('detail history across feature switches', () => {
	it('returns to the current feature after the other feature replaces its predecessor', () => {
		let projectStack = openProjectHistory('Errands');
		history.back(); dismissProjectHistory(projectStack);
		const projects = save();
		restore({ state: null, url: '/notifications?section=reading' });
		let readingStack = openReadingArticleHistory('article');
		history.back(); dismissReadingArticleHistory(readingStack);
		let reading = save();

		for (let cycle = 0; cycle < 3; cycle++) {
			restore(projects);
			projectStack = openProjectHistory('Errands');
			history.back();
			expect(new URL(location.href).searchParams.get('section')).toBeNull();
			expect(new URL(location.href).searchParams.has('project')).toBe(false);
			dismissProjectHistory(projectStack);
			Object.assign(projects, save());

			restore(reading);
			readingStack = openReadingArticleHistory('article');
			history.back();
			expect(new URL(location.href).searchParams.get('section')).toBe('reading');
			expect(new URL(location.href).searchParams.has('item')).toBe(false);
			dismissReadingArticleHistory(readingStack);
			reading = save();
		}
	});

	it('reuses the detail slot for repeated visits within one feature', () => {
		for (const [open, dismiss] of [
			[openProjectHistory, dismissProjectHistory],
			[openReadingArticleHistory, dismissReadingArticleHistory],
		] as const) {
			const stack = open('first');
			const length = entries.length;
			history.back(); dismiss(stack);
			const next = open('second');
			expect(next).toBe(stack);
			history.back(); dismiss(next);
			expect(entries).toHaveLength(length);
		}
	});
});
