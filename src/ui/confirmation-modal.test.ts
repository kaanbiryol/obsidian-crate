import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MockModal,
	MockSetting,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../test/fakes/obsidian-ui';

vi.mock('react-dom/client', () => ({
	createRoot: (element: { textContent: string }) => ({
		render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); },
		unmount: vi.fn(),
	}),
}));

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
});

describe('openConfirmationModal', () => {
	it('resolves true when the confirm button is selected', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { openConfirmationModal } = await import('./confirmation-modal');

		const resultPromise = openConfirmationModal({} as never, {
			title: 'Force full sync',
			message: 'Overwrite the remote vault with local files?',
			details: ['Remote-only files will be deleted.'],
			confirmText: 'Force full sync',
			warning: true,
		});

		expect(MockModal.instances).toHaveLength(1);
		expect(MockSetting.instances).toHaveLength(1);
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('reminder-modal-header');
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Force full sync');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('Overwrite the remote vault with local files?');
		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('Remote-only files will be deleted.');

		MockSetting.instances[0]?.buttons[1]?.click();

		await expect(resultPromise).resolves.toBe(true);
	});

	it('resolves false when the cancel button is selected', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { openConfirmationModal } = await import('./confirmation-modal');

		const resultPromise = openConfirmationModal({} as never, {
			title: 'Reset local configuration',
			message: 'Clear this device\'s Crate configuration?',
			confirmText: 'Reset local data',
			cancelText: 'Keep current setup',
			warning: true,
		});

		expect(MockSetting.instances[0]?.buttons[0]?.buttonEl.textContent).toBe('Keep current setup');
		MockSetting.instances[0]?.buttons[0]?.click();

		await expect(resultPromise).resolves.toBe(false);
	});
});
