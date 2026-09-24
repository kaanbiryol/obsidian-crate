import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockModal, createObsidianUiModule, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';

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

function findLink(element: FakeElement): FakeElement | undefined {
	if (element.tagName === 'a') return element;
	for (const child of element.children) {
		const link = findLink(child);
		if (link) return link;
	}
	return undefined;
}

it('offers a browser link that can be tapped after a request completes', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openExternalBrowserModal } = await import('./external-browser-modal');
	const url = 'https://worker.example.com/notifications?token=short-lived';
	openExternalBrowserModal({} as never, url, {
		title: 'Open reminders web app',
		message: 'Open in your browser.',
		linkText: 'Open reminders',
		showCopyableUrl: true,
	});

	const modal = MockModal.instances[0]!;
	const link = findLink(modal.contentEl);
	expect(modal.titleEl.textContent).toBe('Open reminders web app');
	expect(modal.contentEl.collectText()).toContain('Open in your browser.');
	expect(link?.textContent).toBe('Open reminders');
	expect(link?.getAttribute('href')).toBe(url);
	expect(link?.getAttribute('target')).toBe('_blank');
	expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	expect(link?.classNames.has('external-link')).toBe(true);
	expect((modal.contentEl.children.at(-1)?.children.at(-1) as FakeElement & { value: string }).value).toBe(url);
});
