import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';

vi.mock('react-dom/client', () => ({ createRoot: (element: { textContent: string }) => ({
	render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); }, unmount: vi.fn(),
}) }));

const { window, document } = parseHTML('<html><body></body></html>');

beforeAll(() => {
	// The Obsidian mock installs its element helpers on these globals when first imported.
	// linkedom's window reads timers from the global object, so fake timers apply.
	for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event']) {
		vi.stubGlobal(name, (window as unknown as Record<string, unknown>)[name]);
	}
	// linkedom has no :focus; nothing holds focus in these tests.
	Object.assign(window.HTMLElement.prototype, {
		querySelector(this: HTMLElement, selector: string) { return selector.includes(':focus') ? null : this.querySelectorAll(selector)[0] ?? null; },
		getClientRects: () => [{}],
		focus() {},
		createSpan(this: HTMLElement, info?: DomElementInfo) { return this.createEl('span', info); },
	});
});
afterAll(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

const deleted = (path: string, created_at = '2026-11-20 10:00:00'): RemoteFileVersion =>
	({ storage_key: `key-${path}`, path, hash: 'a'.repeat(64), size: 1, reason: 'deleted', created_at, expires_at: 0 });
const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('.crate-deleted-file'));
const row = (container: HTMLElement, path: string) => rows(container).find(button => button.getAttribute('data-path') === path);
const button = (container: HTMLElement, text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(el => el.textContent?.includes(text));

function runtime(pages: (query: FileVersionQuery) => Promise<FileVersionsPage>, options: { local?: Set<string>; remote?: Set<string>; pending?: RemoteFileVersion[] } = {}) {
	const local = options.local ?? new Set<string>();
	const remote = options.remote ?? new Set<string>();
	return {
		local,
		app: { vault: { adapter: { exists: async (path: string) => local.has(path) }, getFileByPath: () => null } },
		runtime: {
			listRecentFileVersions: vi.fn(pages),
			findRemoteFiles: vi.fn(async (paths: string[]) => new Set(paths.filter(path => remote.has(path)))),
			getPendingRestores: () => options.pending ?? [],
			loadFileHistoryPreview: vi.fn(async () => ({ saved: 'saved', current: '' })),
			restoreRecentFileVersion: vi.fn(async () => ({ success: true, errors: [] })),
			loadCurrentSyncedPreview: vi.fn().mockRejectedValue(new Error('This file is no longer on the server.')),
		},
	};
}

async function mount(pages: (query: FileVersionQuery) => Promise<FileVersionsPage>, options?: Parameters<typeof runtime>[1]) {
	const { DeletedFilesBrowser } = await import('./deleted-files-browser');
	const fixture = runtime(pages, options);
	const container = document.body.createDiv();
	const browser = new DeletedFilesBrowser(container, fixture.app as never, fixture.runtime as never);
	return { ...fixture, container, browser };
}

it('lists files deleted now once each, by day, and shows the selected one beside the list', async () => {
	const { runtime, container } = await mount(async query => query.path ? { versions: [deleted(query.path)], hasMore: false } : {
		versions: [deleted('Projects/plan.md'), deleted('Projects/plan.md', '2026-11-01 10:00:00'), deleted('back.md'),
			{ ...deleted('edited.md'), reason: 'replaced' }, deleted('top.md'), deleted('Archive/old.png', '2026-11-18 09:00:00')],
		hasMore: false,
	}, { remote: new Set(['back.md']) });
	await vi.waitFor(() => expect(row(container, 'top.md')).toBeDefined());
	expect(rows(container).map(el => el.getAttribute('data-path'))).toEqual(['Projects/plan.md', 'top.md', 'Archive/old.png']);
	expect(Array.from(container.querySelectorAll('.crate-history-group'), el => el.textContent)).toHaveLength(2);
	// Notes drop their extension; other files keep it.
	expect(row(container, 'Projects/plan.md')!.querySelector('.crate-history-file-name')!.textContent).toBe('plan');
	expect(row(container, 'Archive/old.png')!.querySelector('.crate-history-file-name')!.textContent).toBe('old.png');
	expect(row(container, 'Projects/plan.md')!.querySelector('.crate-history-file-folder')!.textContent).toMatch(/^Projects · /);
	expect(runtime.listRecentFileVersions).toHaveBeenCalledWith({});

	row(container, 'Projects/plan.md')!.click();
	expect(container.getAttribute('data-pane')).toBe('file');
	expect(row(container, 'Projects/plan.md')!.getAttribute('aria-current')).toBe('true');
	expect(container.querySelector('.crate-deleted-file-header h3')!.textContent).toBe('Projects/plan.md');
	await vi.waitFor(() => expect(runtime.listRecentFileVersions).toHaveBeenLastCalledWith({ path: 'Projects/plan.md', cursor: undefined }));
	// A deleted file opens on its newest retained version, ready to restore.
	await vi.waitFor(() => expect(container.querySelector('[data-version-key="key-Projects/plan.md"]')?.getAttribute('aria-current')).toBe('true'));
	expect(button(container, 'Restore this version')).toBeDefined();
	expect(runtime.loadCurrentSyncedPreview).not.toHaveBeenCalled();

	button(container, 'Deleted files')!.click();
	expect(container.getAttribute('data-pane')).toBe('files');
});

it('drops a file from the list once its restore finishes and keeps its versions in view', async () => {
	const pending = deleted('a.md');
	const { container, local, runtime } = await mount(async query => ({ versions: query.path ? [deleted(query.path)] : [deleted('a.md'), deleted('b.md')], hasMore: false }), { pending: [pending] });
	await vi.waitFor(() => expect(row(container, 'b.md')).toBeDefined());
	row(container, 'a.md')!.click();
	await vi.waitFor(() => expect(container.querySelector('[data-version-key="key-a.md"]')).not.toBeNull());
	container.querySelector<HTMLButtonElement>('[data-version-key="key-a.md"]')!.click();
	await vi.waitFor(() => expect(button(container, 'Resume restore')).toBeDefined());
	local.add('a.md');
	button(container, 'Resume restore')!.click();
	await vi.waitFor(() => expect(row(container, 'a.md')).toBeUndefined());
	expect(runtime.restoreRecentFileVersion).toHaveBeenCalledOnce();
	expect(row(container, 'b.md')).toBeDefined();
	expect(container.querySelector('.crate-deleted-file-header h3')!.textContent).toBe('a.md');
});

it('searches after typing pauses and starts the list again', async () => {
	const { runtime, container, browser } = await mount(async query => ({ versions: query.search ? [deleted('notes/plan.md')] : [deleted('other.md')], hasMore: false }));
	await vi.waitFor(() => expect(row(container, 'other.md')).toBeDefined());
	expect(browser.searchEl.type).toBe('search');
	expect(browser.searchEl.getAttribute('aria-label')).toBe('Search deleted files');
	vi.useFakeTimers();
	for (const value of ['pl', 'plan']) {
		browser.searchEl.value = value;
		browser.searchEl.dispatchEvent(new Event('input'));
	}
	await vi.advanceTimersByTimeAsync(300);
	vi.useRealTimers();
	await vi.waitFor(() => expect(row(container, 'notes/plan.md')).toBeDefined());
	expect(runtime.listRecentFileVersions.mock.calls.map(([query]) => query.search)).toEqual([undefined, 'plan']);
	expect(row(container, 'other.md')).toBeUndefined();
});

it('loads more with the server cursor and retries a failed load', async () => {
	let fail = false;
	const { runtime, container } = await mount(async query => {
		if (fail) { fail = false; throw new Error('Offline'); }
		return query.cursor ? { versions: [deleted('older.md')], hasMore: false } : { versions: Array.from({ length: 20 }, (_, index) => deleted(`file-${index}.md`)), hasMore: true, nextCursor: 'next' };
	});
	await vi.waitFor(() => expect(button(container, 'Load more')).toBeDefined());
	fail = true;
	button(container, 'Load more')!.click();
	await vi.waitFor(() => expect(button(container, 'Retry')).toBeDefined());
	expect(container.textContent).toContain('Offline');
	button(container, 'Retry')!.click();
	await vi.waitFor(() => expect(row(container, 'older.md')).toBeDefined());
	expect(runtime.listRecentFileVersions).toHaveBeenLastCalledWith({ cursor: 'next' });
	expect(row(container, 'file-0.md')).toBeDefined();
	expect(button(container, 'Load more')).toBeUndefined();
});

it('says when no deleted files are kept, and when none match a search', async () => {
	const { container, browser } = await mount(async () => ({ versions: [], hasMore: false }));
	await vi.waitFor(() => expect(container.textContent).toContain('No deleted files. Deleted files stay here for the history period'));
	vi.useFakeTimers();
	browser.searchEl.value = 'plan';
	browser.searchEl.dispatchEvent(new Event('input'));
	await vi.advanceTimersByTimeAsync(300);
	vi.useRealTimers();
	await vi.waitFor(() => expect(container.textContent).toContain('No deleted files match your search.'));
});

it('opens deleted files from the Vault history header, loads them once, and goes back to syncs', async () => {
	const { VaultHistoryModal } = await import('./vault-history-modal');
	const fixture = runtime(async () => ({ versions: [deleted('gone.md')], hasMore: false }));
	const onClosed = vi.fn();
	const modal = new VaultHistoryModal(fixture.app as never, [], {}, fixture.runtime as never, onClosed);
	modal.open();
	const header = () => modal.contentEl.querySelector('.crate-modal-header-host')!.textContent;
	const [syncs, deletedPanel] = Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.crate-vault-history-panel'));
	expect(header()).toContain('Vault history');
	expect(header()).toContain('Deleted files');
	expect([syncs!.hidden, deletedPanel!.hidden]).toEqual([false, true]);
	expect(fixture.runtime.listRecentFileVersions).not.toHaveBeenCalled();

	modal.show('deleted');
	expect(header()).toContain('Deleted files');
	expect(header()).not.toContain('Vault history');
	expect([syncs!.hidden, deletedPanel!.hidden]).toEqual([true, false]);
	await vi.waitFor(() => expect(row(deletedPanel!, 'gone.md')).toBeDefined());
	modal.show('syncs');
	expect(header()).toContain('Vault history');
	modal.show('deleted');
	expect(fixture.runtime.listRecentFileVersions).toHaveBeenCalledOnce();
	modal.close();
	expect(onClosed).toHaveBeenCalledOnce();

	const direct = new VaultHistoryModal(fixture.app as never, [], {}, fixture.runtime as never, () => {}, 'deleted');
	direct.open();
	expect(direct.contentEl.querySelector('.crate-modal-header-host')!.textContent).not.toContain('Vault history');
	direct.close();
});
