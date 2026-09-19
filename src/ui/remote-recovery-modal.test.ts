import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockModal, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';
import type { FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';

vi.mock('react-dom/client', () => ({ createRoot: (element: { textContent: string }) => ({
	render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); }, unmount: vi.fn(),
}) }));
afterEach(() => { resetObsidianUiMocks(); vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('obsidian'); });
const clicks = new WeakMap<FakeElement, () => unknown>();
const descendants = (el: FakeElement): FakeElement[] => [el, ...el.children.flatMap(descendants)];
beforeEach(() => {
	vi.spyOn(FakeElement.prototype, 'addEventListener').mockImplementation(function(this: FakeElement, type, listener) {
		if (type === 'click') clicks.set(this, () => listener({} as Event));
	});
	Object.assign(FakeElement.prototype, { querySelector: () => null, focus: () => {} });
});
const button = (text: string) => {
	const settingButton = MockSetting.instances.flatMap(setting => setting.buttons).filter(item => item.buttonEl.textContent === text).at(-1);
	if (settingButton) return settingButton;
	const native = MockModal.instances.flatMap(modal => descendants(modal.contentEl)).filter(el => el.tagName === 'button' && (el.textContent === text || el.getAttribute('aria-label') === text || (!el.textContent && el.collectText().includes(text))) && clicks.has(el)).at(-1);
	return native ? { click: () => clicks.get(native)!() } : MockSetting.instances.flatMap(setting => setting.buttons).filter(item => item.buttonEl.textContent === text).at(-1)!;
};
const row = { path: 'older.md', hash: 'a'.repeat(64), storage_key: 'retained', size: 10, created_at: '2026-09-09', expires_at: Date.now() + 300_000, reason: 'deleted' as const };
async function open(listRecentFileVersions = vi.fn<(...args: unknown[]) => Promise<FileVersionsPage>>().mockResolvedValue({ versions: [row], hasMore: false }), pending: RemoteFileVersion[] = [], initialPath = 'new.md', onBack?: () => void) {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile: false } }));
	const { openRemoteRecoveryModal } = await import('./remote-recovery-modal');
	const runtime = { getSyncHistory: () => [{ timestamp: '2026-09-19T16:00:00Z', type: 'sync', success: true, uploaded: 0, downloaded: 1, merged: 0, deleted: 0, conflictCount: 0, errorCount: 0, downloadedPaths: ['older.md'] }], loadCurrentSyncedPreview: vi.fn().mockResolvedValue({ file: { hash: 'a'.repeat(64), revision: 'current', size: 12, modified: '2026-09-19' }, text: 'synced contents' }), loadFileHistoryPreview: vi.fn().mockResolvedValue({ saved: 'saved text', current: 'local text' }), getPendingRestores: vi.fn().mockReturnValue(pending), listRecentFileVersions, restoreRecentFileVersion: vi.fn().mockResolvedValue({ success: true, errors: [] }) };
	const file = { path: 'new.md', extension: 'md', stat: { size: 12, mtime: 1 } };
	openRemoteRecoveryModal({ vault: { getFiles: () => [file], getFileByPath: (path: string) => path === file.path ? file : null, cachedRead: async () => 'local contents' } } as never, runtime as never, initialPath, onBack);
	return { runtime, modal: MockModal.instances[0]! };
}

it('opens versions directly without a vault browser', async () => {
 const { runtime, modal } = await open();
 await vi.waitFor(() => expect(modal.contentEl.collectText()).toContain('local contents'));
 expect(button('← All files')).toBeUndefined();
 expect(button('← Sync activity')).toBeUndefined();
 expect(MockSetting.instances.flatMap(setting => setting.texts)).toHaveLength(0);
 expect(runtime.loadCurrentSyncedPreview).not.toHaveBeenCalled();
 expect(runtime.listRecentFileVersions).toHaveBeenCalledWith({ path: 'new.md', cursor: undefined });
});
it('returns to Sync activity only when opened with a back destination', async () => {
 const onBack = vi.fn();
 const { modal } = await open(undefined, [], 'older.md', onBack);
 const close = vi.spyOn(modal, 'close');
 button('← Sync activity').click();
 expect(close).toHaveBeenCalledOnce();
 expect(onBack).toHaveBeenCalledOnce();
});
it('opens a deleted file directly from Sync Activity', async () => {
 const { runtime } = await open(undefined, [], 'older.md');
 await vi.waitFor(() => expect(runtime.listRecentFileVersions).toHaveBeenCalledWith({ path: 'older.md', cursor: undefined }));
 expect(button('← All files')).toBeUndefined();
 expect(runtime.loadCurrentSyncedPreview).toHaveBeenCalledWith('older.md');
});
it('loads older versions for the selected file and confirms restore before mutation', async () => {
 const list = vi.fn<(...args: unknown[]) => Promise<FileVersionsPage>>()
  .mockResolvedValueOnce({ versions: [row], hasMore: true, nextCursor: 'older' })
  .mockResolvedValue({ versions: [{ ...row, storage_key: 'oldest' }], hasMore: false });
 const { runtime } = await open(list, [], 'older.md');
 await vi.waitFor(() => expect(button('Older versions')).toBeDefined()); button('Older versions').click();
 await vi.waitFor(() => expect(list).toHaveBeenLastCalledWith({ path: 'older.md', cursor: 'older' }));
 const version = MockModal.instances.flatMap(modal => descendants(modal.contentEl)).find(el => el.getAttribute('data-version-key') === 'oldest')!;
 clicks.get(version)!();
 await vi.waitFor(() => expect(button('Restore this version')).toBeDefined()); button('Restore this version').click();
 await vi.waitFor(() => expect(MockModal.instances).toHaveLength(2));
 expect(runtime.restoreRecentFileVersion).not.toHaveBeenCalled(); button('Restore').click();
 await vi.waitFor(() => expect(runtime.restoreRecentFileVersion).toHaveBeenCalledWith(expect.objectContaining({ storage_key: 'oldest' })));
});
it('keeps the current file usable when saved history cannot be loaded', async () => {
 const { modal } = await open(vi.fn<(...args: unknown[]) => Promise<FileVersionsPage>>().mockRejectedValue(new Error('Offline')));
 await vi.waitFor(() => expect(modal.contentEl.collectText()).toContain('Offline'));
 expect(modal.contentEl.collectText()).toContain('local contents');
 expect(button('Retry versions')).toBeDefined();
});
