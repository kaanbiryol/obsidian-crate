import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushedScreenHistory } from './pushed-screen-history';

let entries: { state: unknown; url: string; snapshot?: string }[];
let index: number;
let rendered: string;
const current = () => entries[index]!;
const traverse = (offset: number) => { index += offset; window.dispatchEvent(new Event('popstate')); };
beforeEach(() => {
	entries = [{ state: { readingArticle: true, readingStackId: 'library', pwaBackDestination: 'readingArticle' }, url: 'https://crate.test/notifications?section=reading&item=article' }];
	index = 0; rendered = 'settings';
	vi.stubGlobal('window', new EventTarget());
	vi.stubGlobal('location', { get href() { return current().url; } });
	vi.stubGlobal('history', {
		get state() { return current().state; },
		replaceState(state: unknown, _unused: string, url: string) { entries[index] = { ...current(), state, url }; },
		pushState(state: unknown, _unused: string, url: string) {
			current().snapshot = rendered;
			entries.splice(++index, entries.length, { state, url });
		},
		back: () => traverse(-1),
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('pushed screen history', () => {
	it('captures the visible root and consumes Back without closing the underlying article', () => {
		const navigation = createPushedScreenHistory(['shortcut', 'logout']);
		navigation.install(vi.fn());
		const featureRouter = vi.fn(); window.addEventListener('popstate', featureRouter);
		navigation.push('shortcut');
		expect(entries[0]?.snapshot).toBe('settings');
		expect(history.state).toMatchObject({ readingArticle: true, pwaBackDestination: 'pushed-page' });
		history.back();
		expect(navigation.getSnapshot()).toMatchObject({ page: null, immediate: true, closing: false });
		expect(history.state).toMatchObject({ readingArticle: true, readingStackId: 'library', pwaBackDestination: 'readingArticle' });
		expect(featureRouter).not.toHaveBeenCalled();
	});

	it('waits for the app Back animation and handles repeated visits without growing history', () => {
		const navigation = createPushedScreenHistory(['shortcut', 'logout']); navigation.install(vi.fn());
		for (const page of ['shortcut', 'logout', 'shortcut'] as const) {
			rendered = `settings before ${page}`;
			navigation.push(page);
			expect(entries).toHaveLength(2);
			expect(entries[0]?.snapshot).toBe(rendered);
			navigation.back();
			expect(index).toBe(1);
			expect(navigation.getSnapshot().closing).toBe(true);
			navigation.finishBack(); navigation.finishBack();
			expect(index).toBe(0);
			expect(navigation.getSnapshot().closing).toBe(false);
		}
	});

	it('reopens an owned page on Forward after its sheet closed', () => {
		const navigation = createPushedScreenHistory(['shortcut']); const reveal = vi.fn();
		navigation.install(reveal);
		navigation.push('shortcut'); history.back(); navigation.reset();
		traverse(1);
		expect(navigation.getSnapshot()).toMatchObject({ page: 'shortcut', immediate: true, closing: false });
		expect(reveal).toHaveBeenCalledOnce();
	});

	it('leaves unrelated feature traversals alone and removes its listener', () => {
		const navigation = createPushedScreenHistory(['shortcut']); const dispose = navigation.install(vi.fn());
		const featureRouter = vi.fn(); window.addEventListener('popstate', featureRouter);
		window.dispatchEvent(new Event('popstate'));
		expect(featureRouter).toHaveBeenCalledOnce();
		navigation.push('shortcut'); dispose(); history.back();
		expect(featureRouter).toHaveBeenCalledTimes(2);
	});

	it('clears an active page after logout without changing its underlying URL', () => {
		const navigation = createPushedScreenHistory(['logout']); navigation.install(vi.fn());
		const parent: unknown = history.state;
		navigation.push('logout'); navigation.reset();
		expect(history.state).toEqual(parent);
		expect(location.href).toContain('item=article');
		expect(navigation.getSnapshot().page).toBeNull();
	});

	it('does not restore an enrollment token removed during logout', () => {
		history.replaceState(history.state, '', 'https://crate.test/notifications?token=enrollment');
		const navigation = createPushedScreenHistory(['logout']);
		navigation.push('logout');
		history.replaceState(history.state, '', 'https://crate.test/notifications');
		navigation.reset();
		expect(location.href).toBe('https://crate.test/notifications');
	});

	it('queues a quick reopen until the previous Back traversal finishes', () => {
		const navigation = createPushedScreenHistory(['shortcut', 'logout']); navigation.install(vi.fn());
		navigation.push('shortcut');
		const previousVisit = navigation.getSnapshot().entryId;
		navigation.back(); navigation.push('shortcut');
		expect(navigation.getSnapshot().closing).toBe(true);
		navigation.finishBack();
		expect(navigation.getSnapshot()).toMatchObject({ page: 'shortcut', closing: false, immediate: false });
		expect(navigation.getSnapshot().entryId).not.toBe(previousVisit);
		expect(entries).toHaveLength(2);
	});
});
