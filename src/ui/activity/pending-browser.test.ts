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
	const { load, mount, panel } = await fixture(paths);
	await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(150));
	await vi.waitFor(() => expect(statuses(panel)).not.toContain('Checking…'));

	const rebuilt = mount([...paths, 'added.md']);
	expect(statuses(rebuilt).slice(0, 150)).toEqual(Array(150).fill('+1 −1'));
	await vi.waitFor(() => expect(statuses(rebuilt).at(-1)).toBe('+1 −1'));
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
