import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';

vi.mock('obsidian', () => createObsidianUiModule());
vi.mock('./shared/SharedModal', () => ({ SharedModal: class {
	contentEl = new FakeElement('div');
	bodyEl = this.contentEl.createDiv();
	modalEl = new FakeElement('div');
	openLayout() {}
	onClose() {}
} }));

afterEach(() => { vi.unstubAllGlobals(); resetObsidianUiMocks(); });

async function openDialog(writeText: ReturnType<typeof vi.fn>) {
	// Copy remains usable even when the QR renderer returns an invalid document.
	vi.stubGlobal('DOMParser', class { parseFromString() { return { documentElement: { tagName: 'invalid' } }; } });
	vi.stubGlobal('navigator', { clipboard: { writeText } });
	const { QRModal } = await import('./qr-modal');
	new QRModal({} as never, 'https://crate.example/notifications?token=fresh').onOpen();
	MockSetting.instances.flatMap(row => row.buttons).find(button => button.buttonEl.textContent === 'Copy link')!.click();
}

it('copies the same setup URL shown by the QR dialog', async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	await openDialog(writeText);
	await vi.waitFor(() => expect(noticeMessages).toContain('Setup link copied'));
	expect(writeText).toHaveBeenCalledWith('https://crate.example/notifications?token=fresh');
});

it('reveals a selectable link in the dialog if clipboard access fails', async () => {
	await openDialog(vi.fn().mockRejectedValue(new Error('Clipboard denied')));
	await vi.waitFor(() => expect(MockSetting.instances.some(row => row.nameEl.textContent === 'Copy this link')).toBe(true));
	const fallback = MockSetting.instances.find(row => row.nameEl.textContent === 'Copy this link')!;
	expect(fallback.texts[0]!.inputEl.value).toBe('https://crate.example/notifications?token=fresh');
	expect(fallback.texts[0]!.inputEl.readOnly).toBe(true);
});
