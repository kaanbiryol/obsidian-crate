import { cancelDetailHistoryOpen, installDetailHistory } from './detail-history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissProjectHistory, openProjectHistory } from './project-history';
import { dismissReadingArticleHistory, openReadingArticleHistory } from './reading/article-history';

interface Entry { state: unknown; url: string; snapshot?: string }
let entries: Entry[], index: number;
let rendered: string;
const current = () => entries[index]!;
const save = () => ({ ...current() });
const restore = (entry: Entry) => history.replaceState(entry.state, '', entry.url);

beforeEach(() => {
	entries = [{ state: null, url: 'https://crate.test/notifications' }]; index = 0; rendered = 'light list';
	vi.stubGlobal('window', new EventTarget());
	installDetailHistory();
	vi.stubGlobal('location', { get href() { return current().url; } });
	vi.stubGlobal('history', {
		get state() { return current().state; },
		replaceState(state: unknown, _unused: string, url: string | URL) {
			entries[index] = { ...current(), state, url: new URL(url, current().url).href };
		},
		pushState(state: unknown, _unused: string, url: string | URL) {
			current().snapshot = rendered;
			const next = { state, url: new URL(url, current().url).href };
			entries.splice(++index, entries.length, next);
		},
		back() { if (index > 0) { index--; window.dispatchEvent(new Event('popstate')); } },
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('detail history across feature switches', () => {
	it('returns to the current feature after the other feature replaces its predecessor', async () => {
		let projectStack = await openProjectHistory('Errands');
		history.back(); dismissProjectHistory(projectStack);
		const projects = save();
		restore({ state: null, url: '/notifications?section=reading' });
		let readingStack = await openReadingArticleHistory('article');
		history.back(); dismissReadingArticleHistory(readingStack);
		let reading = save();

		for (let cycle = 0; cycle < 3; cycle++) {
			restore(projects);
			projectStack = await openProjectHistory('Errands');
			history.back();
			expect(new URL(location.href).searchParams.get('section')).toBeNull();
			expect(new URL(location.href).searchParams.has('project')).toBe(false);
			dismissProjectHistory(projectStack);
			Object.assign(projects, save());

			restore(reading);
			readingStack = await openReadingArticleHistory('article');
			history.back();
			expect(new URL(location.href).searchParams.get('section')).toBe('reading');
			expect(new URL(location.href).searchParams.has('item')).toBe(false);
			dismissReadingArticleHistory(readingStack);
			reading = save();
		}
	});

	it('refreshes the back destination across reading tabs without growing history', async () => {
		let previousStack: string | null | undefined;
		for (const section of ['inbox', 'favorites', 'archived', 'highlights', 'inbox'] as const) {
			const stack = await openReadingArticleHistory('article', section);
			if (previousStack) expect(stack).toBe(previousStack);
			history.back();
			expect(history.state).toMatchObject({ readingSection: section, readingStackId: stack });
			dismissReadingArticleHistory(stack);
			const length = entries.length;
			expect(await openReadingArticleHistory('another', section)).toBe(stack);
			// Retrying an open article must preserve its original library destination.
			expect(await openReadingArticleHistory('another')).toBe(stack);
			history.back();
			expect(history.state).toMatchObject({ readingSection: section });
			dismissReadingArticleHistory(stack);
			expect(entries).toHaveLength(length);
			previousStack = stack;
		}
	});

	it('reuses the detail slot for repeated visits within one feature', async () => {
		for (const [open, dismiss] of [
			[openProjectHistory, dismissProjectHistory],
			[openReadingArticleHistory, dismissReadingArticleHistory],
		] as const) {
			const stack = await open('first');
			const length = entries.length;
			history.back(); dismiss(stack);
			const next = await open('second');
			expect(next).toBe(stack);
			history.back(); dismiss(next);
			expect(entries).toHaveLength(length);
		}
	});
	it.each([
		['projects', openProjectHistory, dismissProjectHistory],
		['reading', openReadingArticleHistory, dismissReadingArticleHistory],
	] as const)('refreshes all captured pixels for %s, even within the same destination', async (_feature, open, dismiss) => {
		let stack = await open('first');
		history.back(); dismiss(stack);
		const length = entries.length;
		for (const state of ['dark list', 'edited title', 'filtered results', 'scrolled list', 'light list']) {
			rendered = state;
			stack = await open('next');
			expect(entries[index - 1]?.snapshot).toBe(state);
			expect(entries).toHaveLength(length);
			history.back(); dismiss(stack);
			expect(index).toBe(entries.length - 1); // No forward detail preview remains.
		}
	});

	it('serializes rapid opens and consumes only the internal predecessor traversal', async () => {
		const stack = await openProjectHistory('first');
		history.back(); dismissProjectHistory(stack);
		const back = vi.spyOn(history, 'back').mockImplementation(() => {});
		const pending = openProjectHistory('second');
		expect(await openProjectHistory('third')).toBeNull();
		expect(back).toHaveBeenCalledTimes(1);
		index--;
		const event = new Event('popstate');
		const stop = vi.spyOn(event, 'stopImmediatePropagation');
		window.dispatchEvent(event);
		expect(await pending).toBe(stack);
		expect(stop).toHaveBeenCalledOnce();
		expect(history.state).toMatchObject({ reminderProject: 'second' });
	});

	it('lets a feature switch cancel an open while the browser traversal is pending', async () => {
		const stack = await openProjectHistory('first');
		history.back(); dismissProjectHistory(stack);
		vi.spyOn(history, 'back').mockImplementation(() => {});
		const pending = openProjectHistory('second');
		restore({ state: null, url: '/notifications?section=reading' });
		cancelDetailHistoryOpen();
		index--;
		window.dispatchEvent(new Event('popstate'));
		expect(await pending).toBeNull();
		expect(new URL(location.href).searchParams.get('section')).toBe('reading');
		expect(history.state).toBeNull();
	});

	it('preserves the library URL when refreshing a Reading predecessor', async () => {
		restore({ state: null, url: '/notifications?section=reading&tab=favorites&folder=Notes' });
		for (let visit = 0; visit < 2; visit++) {
			const stack = await openReadingArticleHistory('article', 'favorites');
			history.back();
			expect(new URL(location.href).search).toBe('?section=reading&tab=favorites&folder=Notes');
			dismissReadingArticleHistory(stack);
		}
	});

	it('does not intercept an unrelated traversal while an open is pending', async () => {
		const stack = await openProjectHistory('first');
		history.back(); dismissProjectHistory(stack);
		vi.spyOn(history, 'back').mockImplementation(() => {});
		const pending = openProjectHistory('second');
		restore({ state: null, url: '/notifications?section=reading' });
		const event = new Event('popstate');
		const stop = vi.spyOn(event, 'stopImmediatePropagation');
		window.dispatchEvent(event);
		expect(await pending).toBeNull();
		expect(stop).not.toHaveBeenCalled();
	});

});
