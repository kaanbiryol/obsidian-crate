import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement, MockSetting, noticeMessages, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

const confirm = vi.fn<(_app: unknown, options: { details: string[] }) => Promise<boolean>>();
beforeEach(() => { resetObsidianUiMocks(); confirm.mockReset(); });
afterEach(() => {
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../confirmation-modal');
});

async function render() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal: confirm }));
	const { renderExclusionCleanup } = await import('./exclusion-cleanup');
	const execute = vi.fn(async () => ({ deleted: ['.trash/reviewed.md'], errors: [] }));
	const createExclusionCleanupReview = vi.fn(async () => ({ paths: ['.trash/reviewed.md'], execute }));
	renderExclusionCleanup(new FakeElement('div') as never, { app: {}, syncRuntime: { createExclusionCleanupReview } } as never);
	return { execute, createExclusionCleanupReview, button: MockSetting.instances[0]!.buttons[0]! };
}

it.each([true, false])('executes the displayed review only after confirmation (%s)', async confirmed => {
	const h = await render();
	confirm.mockResolvedValue(confirmed);
	h.button.click();
	await vi.waitFor(() => expect(h.button.buttonEl.textContent).toBe('Review and remove'));
	expect(confirm.mock.calls[0]![1].details).toContain('.trash/reviewed.md');
	expect(h.createExclusionCleanupReview).toHaveBeenCalledOnce();
	expect(h.execute).toHaveBeenCalledTimes(confirmed ? 1 : 0);
});

it('shows stale-review guidance without reporting cleanup success', async () => {
	const h = await render();
	confirm.mockResolvedValue(true);
	h.execute.mockRejectedValue(new DOMException('Sync exclusions changed. Review the excluded server files again.', 'AbortError'));
	h.button.click();
	await vi.waitFor(() => expect(noticeMessages).toEqual(['Could not remove excluded server files: Sync exclusions changed. Review the excluded server files again.']));
});
