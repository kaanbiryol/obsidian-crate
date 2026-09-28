import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, createObsidianUiModule } from '../../test/fakes/obsidian-ui';

vi.mock('obsidian', () => createObsidianUiModule());
afterEach(() => vi.clearAllMocks());

it('mounts remote details only once on the first expansion', async () => {
	const { createSettingsDisclosure } = await import('./section-helpers');
	const root = new FakeElement('div');
	const onOpen = vi.fn();
	createSettingsDisclosure(root as never, 'Account and devices', { summary: 'Personal account', onOpen });
	const details = root.children[0]!;
	expect(onOpen).not.toHaveBeenCalled();
	details.dispatchEvent(new Event('toggle'));
	expect(onOpen).not.toHaveBeenCalled();
	details.open = true;
	details.dispatchEvent(new Event('toggle'));
	details.dispatchEvent(new Event('toggle'));
	expect(onOpen).toHaveBeenCalledOnce();
	expect(details.getAttribute('data-settings-section')).toBe('Account and devices');
});

it('ignores queued expansion events after the settings page is detached', async () => {
	const { createSettingsDisclosure } = await import('./section-helpers');
	const root = new FakeElement('div');
	const onOpen = vi.fn();
	createSettingsDisclosure(root as never, 'Server', { onOpen });
	const details = root.children[0]!;
	details.open = true;
	details.isConnected = false;
	details.dispatchEvent(new Event('toggle'));
	expect(onOpen).not.toHaveBeenCalled();
});
