import { afterEach, expect, it, vi } from 'vitest';
import { MockModal, MockSetting, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { createAbortError } from '../../sync/abort';
import type { SyncHistoryEntry } from '../../sync/types';

vi.mock('obsidian', () => createObsidianUiModule());
vi.mock('../plugin/mountModalHeader', () => ({ mountModalHeader: () => Object.assign(() => {}, { setTitle: () => {} }) }));
import { HistoryRestoreModal } from './history-restore-modal';

afterEach(() => { resetObsidianUiMocks(); vi.restoreAllMocks(); });

it('closes a cancelled restore without announcing success or offering an error retry', async () => {
	const entry: SyncHistoryEntry = { timestamp: '2026-09-20T10:18:42Z', type: 'sync', success: true,
		uploaded: 1, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0 };
	const restore = vi.fn().mockRejectedValue(createAbortError('Sync cancelled'));
	const onRestored = vi.fn();
	const closed = vi.spyOn(MockModal.prototype, 'close');
	const modal = new HistoryRestoreModal({} as never, entry, async () => ({
		items: [{ path: 'note.md', action: 'revert' }], unchangedCount: 0,
		preview: vi.fn(), restore,
	}), onRestored);
	modal.open();
	await vi.waitFor(() => expect(MockSetting.instances[0]!.buttons[1]!.buttonEl.textContent).toBe('Restore'));
	MockSetting.instances[0]!.buttons[1]!.click();
	await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
	expect(restore).toHaveBeenCalledOnce();
	expect(onRestored).toHaveBeenCalledOnce();
	expect(noticeMessages).toEqual([]);
	expect(MockSetting.instances[0]!.buttons[1]!.buttonEl.textContent).not.toBe('Try again');
});

it('names the files left unchanged because their saved version is no longer kept', async () => {
	const entry: SyncHistoryEntry = { timestamp: '2026-09-20T10:18:42Z', type: 'sync', success: true,
		uploaded: 1, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0 };
	const modal = new HistoryRestoreModal({} as never, entry, async () => ({
		items: [{ path: 'a.md', action: 'revert' }, { path: 'b.md', action: 'revert' }], unchangedCount: 0,
		preview: vi.fn(), restore: vi.fn(async () => ['a.md']),
	}), vi.fn());
	modal.open();
	await vi.waitFor(() => expect(MockSetting.instances[0]!.buttons[1]!.buttonEl.textContent).toBe('Restore'));
	MockSetting.instances[0]!.buttons[1]!.click();
	await vi.waitFor(() => expect(noticeMessages).toHaveLength(1));
	expect(noticeMessages[0]).toBe('Synced vault returned to the selected state, except 1 file whose saved version is no longer kept. It was left unchanged: a.md');
});
