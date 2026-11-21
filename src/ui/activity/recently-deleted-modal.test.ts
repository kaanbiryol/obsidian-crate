import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockModal, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../../protocol/sync-types';

vi.mock('react-dom/client', () => ({ createRoot: (element: { textContent: string }) => ({
	render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); }, unmount: vi.fn(),
}) }));
vi.mock('obsidian', () => createObsidianUiModule());

const descendants = (el: FakeElement): FakeElement[] => [el, ...el.children.flatMap(descendants)];
const buttons = (modal: MockModal) => descendants(modal.contentEl).filter(el => el.tagName === 'button');
const findButton = (modal: MockModal, text: string) => buttons(modal).find(el => el.collectText().includes(text));
const click = (el: FakeElement) => el.dispatchEvent(new Event('click'));
const deleted = (path: string, created_at = '2026-11-20 10:00:00'): RemoteFileVersion =>
	({ storage_key: `key-${path}`, path, hash: 'a'.repeat(64), size: 1, reason: 'deleted', created_at, expires_at: 0 });

beforeEach(() => {
	vi.stubGlobal('window', globalThis);
	// File history focuses its headings, which the fake DOM does not model.
	Object.assign(FakeElement.prototype, { focus: () => {} });
});
afterEach(() => { resetObsidianUiMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function open(pages: (query: FileVersionQuery) => Promise<FileVersionsPage>, options: { local?: Set<string>; remote?: Set<string> } = {}) {
	const local = options.local ?? new Set<string>();
	const remote = options.remote ?? new Set<string>();
	const runtime = {
		listRecentFileVersions: vi.fn(pages),
		findRemoteFiles: vi.fn(async (paths: string[]) => new Set(paths.filter(path => remote.has(path)))),
		getPendingRestores: () => [], loadFileHistoryPreview: vi.fn(), restoreRecentFileVersion: vi.fn(),
		loadCurrentSyncedPreview: vi.fn().mockRejectedValue(new Error('This file is no longer on the server.')),
	};
	const app = { vault: { adapter: { exists: async (path: string) => local.has(path) }, getFileByPath: () => null } };
	const { openRecentlyDeletedModal } = await import('./recently-deleted-modal');
	const onClosed = vi.fn();
	openRecentlyDeletedModal(app as never, runtime, onClosed);
	return { runtime, modal: MockModal.instances[0]!, local, onClosed };
}

it('lists files deleted now, once each, and opens file history for the selected one', async () => {
	const { runtime, modal } = await open(async query => query.path ? { versions: [], hasMore: false } : {
		versions: [deleted('Projects/plan.md'), deleted('Projects/plan.md', '2026-11-01 10:00:00'), deleted('back.md'),
			{ ...deleted('edited.md'), reason: 'replaced' }, deleted('top.md')],
		hasMore: false,
	}, { remote: new Set(['back.md']) });
	await vi.waitFor(() => expect(findButton(modal, 'top.md')).toBeDefined());
	const text = modal.contentEl.collectText();
	expect(text).toContain('Recently deleted');
	expect(text).toContain('Projects · Deleted');
	expect(text).not.toContain('back.md');
	expect(text).not.toContain('edited.md');
	expect(buttons(modal).filter(el => el.collectText().includes('plan.md'))).toHaveLength(1);
	expect(runtime.listRecentFileVersions).toHaveBeenCalledWith({});

	click(findButton(modal, 'plan.md')!);
	expect(MockModal.instances).toHaveLength(2);
	await vi.waitFor(() => expect(runtime.listRecentFileVersions).toHaveBeenLastCalledWith({ path: 'Projects/plan.md', cursor: undefined }));
});

it('drops a file restored from its history when that history closes', async () => {
	const { modal, local } = await open(async query => ({ versions: query.path ? [] : [deleted('a.md'), deleted('b.md')], hasMore: false }));
	await vi.waitFor(() => expect(findButton(modal, 'b.md')).toBeDefined());
	click(findButton(modal, 'a.md')!);
	local.add('a.md');
	MockModal.instances[1]!.close();
	await vi.waitFor(() => expect(findButton(modal, 'a.md')).toBeUndefined());
	expect(findButton(modal, 'b.md')).toBeDefined();
});

it('searches after typing pauses and starts the list again', async () => {
	const { runtime, modal } = await open(async query => ({ versions: query.search ? [deleted('notes/plan.md')] : [deleted('other.md')], hasMore: false }));
	await vi.waitFor(() => expect(findButton(modal, 'other.md')).toBeDefined());
	vi.useFakeTimers();
	const search = MockSetting.instances.flatMap(setting => setting.texts)[0]!;
	expect(search.inputEl.type).toBe('search');
	search.change('pl');
	search.change('plan');
	await vi.advanceTimersByTimeAsync(300);
	vi.useRealTimers();
	await vi.waitFor(() => expect(findButton(modal, 'plan.md')).toBeDefined());
	expect(runtime.listRecentFileVersions.mock.calls.map(([query]) => query.search)).toEqual([undefined, 'plan']);
	expect(findButton(modal, 'other.md')).toBeUndefined();
});

it('loads more with the server cursor and retries a failed load', async () => {
	let fail = false;
	const { runtime, modal } = await open(async query => {
		if (fail) { fail = false; throw new Error('Offline'); }
		return query.cursor ? { versions: [deleted('older.md')], hasMore: false } : { versions: Array.from({ length: 20 }, (_, index) => deleted(`file-${index}.md`)), hasMore: true, nextCursor: 'next' };
	});
	await vi.waitFor(() => expect(findButton(modal, 'Load more')).toBeDefined());
	fail = true;
	click(findButton(modal, 'Load more')!);
	await vi.waitFor(() => expect(findButton(modal, 'Retry')).toBeDefined());
	expect(modal.contentEl.collectText()).toContain('Offline');
	click(findButton(modal, 'Retry')!);
	await vi.waitFor(() => expect(findButton(modal, 'older.md')).toBeDefined());
	expect(runtime.listRecentFileVersions).toHaveBeenLastCalledWith({ cursor: 'next' });
	expect(findButton(modal, 'file-0.md')).toBeDefined();
	expect(findButton(modal, 'Load more')).toBeUndefined();
});

it('says when no deleted files are kept and reports closing', async () => {
	const { modal, onClosed } = await open(async () => ({ versions: [], hasMore: false }));
	await vi.waitFor(() => expect(modal.contentEl.collectText()).toContain('No deleted files found.'));
	modal.close();
	expect(onClosed).toHaveBeenCalledOnce();
});
