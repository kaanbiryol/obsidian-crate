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

describe('selectCloudflareServer', () => {
	it('lets the user choose when an account contains multiple Crate servers', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { selectCloudflareServer } = await import('./cloudflare-server-picker-modal');
		const first = {
			metadata: { workerName: 'crate-0123456789abcdef' },
			modifiedOn: '2026-08-23T09:00:00.000Z',
		};
		const second = {
			metadata: { workerName: 'crate-fedcba9876543210' },
			modifiedOn: null,
		};

		const result = selectCloudflareServer({} as never, [first, second] as never);

		expect(MockModal.instances[0]?.contentEl.collectText()).toContain('reminder-modal-header');
		expect(MockModal.instances[0]?.titleEl.textContent).toBe('Choose a Crate server');
		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'crate-0123456789abcdef',
			'crate-fedcba9876543210',
		]);
		MockSetting.instances[1]?.buttons[0]?.click();
		await expect(result).resolves.toBe(second);
	});
});
