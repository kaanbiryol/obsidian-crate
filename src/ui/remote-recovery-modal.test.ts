import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { MockModal, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';
import type { FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';

vi.mock('react-dom/client', () => ({ createRoot: (element: { textContent: string }) => ({
	render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); }, unmount: vi.fn(),
}) }));
afterEach(() => { resetObsidianUiMocks(); vi.resetModules(); vi.doUnmock('obsidian'); });
const button = (text: string) => MockSetting.instances.flatMap(setting => setting.buttons).filter(item => item.buttonEl.textContent === text).at(-1)!;
const row = { path: 'older.md', hash: 'a'.repeat(64), storage_key: 'retained', size: 10, created_at: '2026-09-09', expires_at: Date.now() + 300_000, reason: 'deleted' as const };
async function open(listRecentFileVersions = vi.fn<(...args: unknown[]) => Promise<FileVersionsPage>>(), pending: RemoteFileVersion[] = []) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openRemoteRecoveryModal } = await import('./remote-recovery-modal');
	const runtime = { getPendingRestores: vi.fn().mockReturnValue(pending), listRecentFileVersions, restoreRecentFileVersion: vi.fn().mockResolvedValue({ success: true, errors: [] }) };
	openRemoteRecoveryModal({} as never, runtime as never);
	return { runtime, modal: MockModal.instances[0]! };
}
it('pages to an older version, searches with a fresh cursor, and confirms its restore', async () => {
	const list = vi.fn<(...args: unknown[]) => Promise<FileVersionsPage>>()
		.mockResolvedValueOnce({ versions: [], hasMore: true, nextCursor: 'next' })
		.mockResolvedValue({ versions: [row], hasMore: false });
	const { runtime } = await open(list);
	await vi.waitFor(() => expect(button('Next')).toBeDefined()); button('Next').click();
	await vi.waitFor(() => expect(list).toHaveBeenLastCalledWith({ cursor: 'next', search: undefined }));
	MockSetting.instances[0]!.texts[0]!.change('older'); button('Search').click();
	await vi.waitFor(() => expect(list).toHaveBeenLastCalledWith({ cursor: undefined, search: 'older' }));
	button('Restore').click();
	await vi.waitFor(() => expect(MockModal.instances).toHaveLength(2));
	expect(runtime.restoreRecentFileVersion).not.toHaveBeenCalled();
	button('Restore').click();
	await vi.waitFor(() => expect(runtime.restoreRecentFileVersion).toHaveBeenCalledWith(row));
});
it('retries failed requests and ignores an old response after a new search', async () => {
	let release!: (page: FileVersionsPage) => void;
	const list = vi.fn<(...args: unknown[]) => Promise<FileVersionsPage>>()
		.mockRejectedValueOnce(new Error('Offline'))
		.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
		.mockResolvedValue({ versions: [row], hasMore: false });
	const { modal } = await open(list);
	await vi.waitFor(() => expect(modal.contentEl.collectText()).toContain('Offline'));
	button('Retry').click(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
	MockSetting.instances[0]!.texts[0]!.change('older'); button('Search').click();
	await vi.waitFor(() => expect(modal.contentEl.collectText()).toContain('older.md'));
	release({ versions: [{ ...row, path: 'stale.md' }], hasMore: false });
	await Promise.resolve(); await Promise.resolve();
	expect(modal.contentEl.collectText()).not.toContain('stale.md');
});

it('resumes a saved restore after its retained history entry expires', async () => {
 const { runtime } = await open(vi.fn().mockResolvedValue({ versions: [], hasMore: false }), [row]);
 await vi.waitFor(() => expect(button('Resume restore')).toBeDefined());
 button('Resume restore').click();
 await vi.waitFor(() => expect(runtime.restoreRecentFileVersion).toHaveBeenCalledWith(row));
 expect(MockModal.instances).toHaveLength(1);
});
