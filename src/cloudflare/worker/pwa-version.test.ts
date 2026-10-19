import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

it('reads the client asset version from the shell when the build omits it', async () => {
	const querySelector = vi.fn((selector: string) => selector === 'meta[name="crate-pwa-asset-version"]'
		? { getAttribute: (name: string) => name === 'content' ? 'shell-version' : null }
		: null);
	vi.stubGlobal('document', { querySelector });
	const { PWA_ASSET_VERSION } = await import('./pwa-version');
	expect(PWA_ASSET_VERSION).toBe('shell-version');
});

it('publishes the asset version in the shell it serves', async () => {
	const { createPwaHtml } = await import('./pwa/html');
	const { PWA_ASSET_VERSION, PWA_ASSET_VERSION_META } = await import('./pwa-version');
	expect(createPwaHtml()).toContain(`<meta name="${PWA_ASSET_VERSION_META}" content="${PWA_ASSET_VERSION}">`);
});

it('falls back to a development version without a shell', async () => {
	const { PWA_ASSET_VERSION } = await import('./pwa-version');
	expect(PWA_ASSET_VERSION).toBe('dev');
});
