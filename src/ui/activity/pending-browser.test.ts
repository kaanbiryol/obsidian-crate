import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import type { PendingDiff } from '../../sync/pending/pending-diff';
import type { PendingBrowserState, PendingChecks } from './pending-browser';

const { window, document } = parseHTML('<html><body></body></html>');
const modified: PendingDiff = { before: 'old', after: 'new', beforeSize: 3, afterSize: 3, kind: 'modified' };
const idle = { label: 'Sync', disabled: false, idle: true };

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
	let checks: PendingChecks | undefined;
	const mount = (keys: string[]) => {
		checks?.dispose();
		const panel = document.createElement('div');
		document.body.replaceChildren(panel);
		checks = renderPendingBrowser(panel, keys, load, state);
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
	const run = vi.fn();
	const panel = document.createElement('div');
	document.body.replaceChildren(panel);
	const state: PendingBrowserState = {};
	const checks = renderPendingBrowser(panel, paths, vi.fn(async () => modified), state, { sync: { describe: () => idle, run }, discard: vi.fn() });
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

	// Every file is checked, so the sync holds none back.
	const sync = panel.querySelector('.crate-browser-sync') as HTMLButtonElement;
	expect(sync.textContent).toBe('Sync 5000 files');
	sync.click();
	expect(run).toHaveBeenCalledExactlyOnceWith([]);
	checks.dispose();
});

it('names what the sync uploads and holds back unchecked files', async () => {
	const { renderPendingBrowser } = await import('./pending-browser');
	const run = vi.fn();
	const panel = document.createElement('div');
	document.body.replaceChildren(panel);
	const checks = renderPendingBrowser(panel, ['a.md', 'b.md'], vi.fn(async () => modified), {}, { sync: { describe: () => idle, run }, discard: vi.fn() });
	const sync = panel.querySelector('.crate-browser-sync') as HTMLButtonElement;
	const boxes = [...panel.querySelectorAll<HTMLInputElement>('.crate-browser-file-check input')];
	const uncheck = (box: HTMLInputElement) => { box.checked = false; box.dispatchEvent(new window.Event('change')); };

	uncheck(boxes[0]!);
	expect(sync.textContent).toBe('Sync 1 file');
	expect(sync.title).toContain('Unchecked files stay on this device');
	sync.click();
	expect(run).toHaveBeenLastCalledWith(['a.md']);

	// With nothing checked, the button still gets remote changes.
	uncheck(boxes[1]!);
	expect(sync.textContent).toBe('Get remote changes');
	expect(sync.disabled).toBe(false);
	sync.click();
	expect(run).toHaveBeenLastCalledWith(['a.md', 'b.md']);
	checks.dispose();
});

it('locks the selection and shows sync progress in the footer, then restores it', async () => {
	const { renderPendingBrowser } = await import('./pending-browser');
	const panel = document.createElement('div');
	document.body.replaceChildren(panel);
	let action = idle;
	const checks = renderPendingBrowser(panel, ['a.md', 'b.md'], vi.fn(async () => modified), {}, { sync: { describe: () => action, run: vi.fn() }, discard: vi.fn() });
	const sync = panel.querySelector('.crate-browser-sync') as HTMLButtonElement;
	const boxes = () => [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

	// The running sync's button stops it and shows a short count; nothing renders below it.
	action = { label: 'Stop sync', disabled: false, idle: false };
	checks.setSyncProgress({ label: '1 / 2', fraction: 0.5 });
	expect(panel.querySelector('.crate-pending-browser')?.classList.contains('is-syncing')).toBe(true);
	expect(sync.textContent).toBe('Stop sync1 / 2');
	expect(sync.getAttribute('aria-label')).toBe('Stop sync, 1 / 2');
	expect(panel.querySelector('.crate-browser-actions')?.children).toHaveLength(1);
	expect(sync.disabled).toBe(false);
	expect(sync.style.getPropertyValue('--crate-sync-progress')).toBe('0.5');
	expect(boxes().every(box => box.disabled)).toBe(true);
	expect(panel.querySelector('.crate-browser-file-name')?.textContent).toBe('a.md');

	action = { label: 'Stopping…', disabled: true, idle: false };
	checks.updateAction();
	expect(sync.textContent).toBe('Stopping…');
	expect(sync.disabled).toBe(true);

	action = idle;
	checks.setSyncProgress();
	expect(sync.textContent).toBe('Sync 2 files');
	expect(sync.disabled).toBe(false);
	expect(boxes().some(box => box.disabled)).toBe(false);
	checks.dispose();
});

it('shows a Crate update bundle as an update listing its files, without diffing it', async () => {
	const { renderPendingBrowser } = await import('./pending-browser');
	const { pendingChangeKey } = await import('../../sync/pending/pending-change');
	const load = vi.fn(async () => modified);
	const state: PendingBrowserState = { configDir: '.obsidian' };
	const panel = document.createElement('div');
	document.body.replaceChildren(panel);
	const checks = renderPendingBrowser(panel, ['.obsidian/crate-update/0.11.0.json', pendingChangeKey('delete', '.obsidian/crate-update/0.10.0.json')], load, state);
	await new Promise(resolve => setTimeout(resolve, 0));
	const names = [...panel.querySelectorAll('.crate-browser-file-name')].map(name => name.textContent);
	expect(names).toEqual(['Crate 0.11.0 update', 'Crate 0.10.0 update']);
	expect([...panel.querySelectorAll('.crate-browser-file-path')].map(path => path.textContent)).toEqual(['styles.css, main.js, manifest.json', 'styles.css, main.js, manifest.json']);
	expect(statuses(panel)).toEqual(['New version', 'Replaced']);
	panel.querySelector<HTMLButtonElement>('.crate-browser-file')!.click();
	expect([...panel.querySelectorAll('.crate-file-diff li')].map(item => item.textContent)).toEqual(['styles.css', 'main.js', 'manifest.json']);
	expect(load).not.toHaveBeenCalled();
	checks.dispose();
});

it('renders the rows in view plus overscan, clamped to the list', async () => {
	const { pendingRowWindow } = await import('./pending-browser');
	expect(pendingRowWindow(0, 480, 48, 1000)).toEqual({ start: 0, end: 20 });
	expect(pendingRowWindow(4800, 480, 48, 1000)).toEqual({ start: 90, end: 120 });
	expect(pendingRowWindow(4810, 500, 48, 1000)).toEqual({ start: 90, end: 121 });
	expect(pendingRowWindow(47_500, 480, 48, 1000)).toEqual({ start: 979, end: 1000 });
	expect(pendingRowWindow(0, 0, 48, 1000)).toEqual({ start: 0, end: 50 });
	expect(pendingRowWindow(0, 480, 48, 3)).toEqual({ start: 0, end: 3 });
});
