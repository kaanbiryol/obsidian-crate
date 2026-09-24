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

it('offers a real Cloudflare link after authorization is prepared on mobile', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { openCloudflareAuthorizationModal } = await import('./cloudflare-authorization-modal');
	const app = {} as never;
	const signal = new AbortController();
	const url = 'https://dash.cloudflare.com/oauth2/auth?state=test&code_challenge=challenge';
	openCloudflareAuthorizationModal(app, url, signal.signal);

	const modal = MockModal.instances[0]!;
	const link = findLink(modal.contentEl);
	expect(modal.titleEl.textContent).toBe('Sign in with Cloudflare');
	expect(link?.textContent).toBe('Open Cloudflare');
	expect(link?.getAttribute('href')).toBe(url);
	expect(link?.getAttribute('target')).toBe('_blank');
	expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	expect(link?.classNames.has('external-link')).toBe(true);
	expect(modal.contentEl.collectText()).toContain('callback page button');
});

it('dismisses the link on callback, replacement, and plugin unload', async () => {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const { dismissCloudflareAuthorizationModal, openCloudflareAuthorizationModal } = await import('./cloudflare-authorization-modal');
	const app = {} as never;
	const signal = new AbortController();
	openCloudflareAuthorizationModal(app, 'https://dash.cloudflare.com/first', signal.signal);
	const first = MockModal.instances[0]!;
	openCloudflareAuthorizationModal(app, 'https://dash.cloudflare.com/second', signal.signal);
	expect(first.contentEl.collectText()).toBe('');
	const second = MockModal.instances[1]!;
	dismissCloudflareAuthorizationModal(app);
	expect(second.contentEl.collectText()).toBe('');
	openCloudflareAuthorizationModal(app, 'https://dash.cloudflare.com/third', signal.signal);
	const third = MockModal.instances[2]!;
	signal.abort();
	expect(third.contentEl.collectText()).toBe('');
});
