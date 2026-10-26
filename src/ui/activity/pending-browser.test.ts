import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import type { PendingDiff } from '../../sync/pending/pending-diff';
import type { PendingBrowserState } from './pending-browser';

const { window, document } = parseHTML('<html><body></body></html>');
const modified: PendingDiff = { before: 'old', after: 'new', beforeSize: 3, afterSize: 3, kind: 'modified' };

beforeAll(() => {
	// The Obsidian mock installs its element helpers on these globals when first imported.
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event']) {
		vi.stubGlobal(name, (window as unknown as Record<string, unknown>)[name]);
	}
	vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
	Object.assign(window.HTMLElement.prototype, {
		getClientRects: () => [{}],
		createSpan(this: HTMLElement, info?: DomElementInfo) { return this.createEl('span', info); },
	});
});
afterAll(() => { vi.unstubAllGlobals(); });

async function fixture(paths: string[]) {
	const { renderPendingBrowser } = await import('./pending-browser');
	const load = vi.fn(async () => modified);
	const state: PendingBrowserState = {};
	const mount = (keys: string[]) => {
		state.dispose?.();
		const panel = document.createElement('div');
		document.body.replaceChildren(panel);
		renderPendingBrowser(panel, keys, load, state);
		return panel;
	};
	return { load, state, mount, panel: mount(paths) };
}

const statuses = (panel: Element) => [...panel.querySelectorAll('.crate-browser-file-status')].map(status => status.textContent);

it('checks only files added since the last rebuild', async () => {
	const paths = Array.from({ length: 150 }, (_, index) => `note-${index}.md`);
	const { load, mount, panel, state } = await fixture(paths);
	await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(150));
	await vi.waitFor(() => expect(statuses(panel)).not.toContain('Checking…'));

	// Statuses are kept for every file, including rows outside the rendered window.
	const rebuilt = mount([...paths, 'added.md']);
	expect(statuses(rebuilt).every(status => status === '+1 −1')).toBe(true);
	await vi.waitFor(() => expect(state.statusLabels?.get('added.md')).toBe('+1 −1'));
	expect([...state.statusLabels!.values()]).toEqual(Array(151).fill('+1 −1'));
	expect(load).toHaveBeenCalledTimes(151);
});

it('checks a long list only when a file is selected, also after a rebuild that adds one file', async () => {
	const paths = Array.from({ length: 5000 }, (_, index) => `note-${index}.md`);
	const { load, mount, panel } = await fixture(paths);
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(load).not.toHaveBeenCalled();
	expect(statuses(panel)[0]).toBe('Not checked');

	const rebuilt = mount([...paths, 'added.md']);
	await new Promise(resolve => setTimeout(resolve, 10));
	expect(load.mock.calls.length).toBeLessThanOrEqual(1);
	(rebuilt.querySelector('.crate-browser-file') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(statuses(rebuilt)[0]).toBe('+1 −1'));
	expect(load).toHaveBeenCalledOnce();
});

it('renders only rows near the viewport while selection, navigation and sync cover every file', async () => {
	const { renderPendingBrowser } = await import('./pending-browser');
	const paths = Array.from({ length: 5000 }, (_, index) => `note-${index}.md`);
	const syncSelected = vi.fn(async () => {});
	const panel = document.createElement('div');
	document.body.replaceChildren(panel);
	const state: PendingBrowserState = {};
	renderPendingBrowser(panel, paths, vi.fn(async () => modified), state, { syncSelected, discard: vi.fn() });
	const names = () => [...panel.querySelectorAll('.crate-browser-file-name')].map(name => name.textContent);
	// An unsized list renders a bounded window instead of 5,000 rows.
	expect(names().length).toBeLessThanOrEqual(50);
	expect(names()[0]).toBe('note-0.md');

	const list = panel.querySelector('.crate-browser-files') as HTMLElement;
	// The test DOM has no layout; give the list a ten-row viewport.
	Object.defineProperty(list, 'clientHeight', { value: 480 });
	list.scrollTop = 2000 * 48;
	list.dispatchEvent(new Event('scroll'));
	expect(names()).toContain('note-2000.md');
	expect(names()).not.toContain('note-0.md');
	expect(names().length).toBeLessThanOrEqual(30);

	// Keyboard navigation reaches rows that were never rendered.
	const focused = panel.querySelector('.crate-browser-file[tabindex="0"]') ?? list;
	focused.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'End' }));
	expect(names()).toContain('note-4999.md');
	expect(panel.querySelector('.crate-browser-file[tabindex="0"] .crate-browser-file-name')?.textContent).toBe('note-4999.md');

	(panel.querySelector('.crate-browser-sync') as HTMLButtonElement).click();
	await vi.waitFor(() => expect(syncSelected).toHaveBeenCalledOnce());
	expect(syncSelected.mock.calls[0]).toEqual([paths]);
	state.dispose?.();
});
