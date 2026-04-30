import { describe, expect, it } from 'vitest';
import { createManifestJson, createPwaHtml, createPwaVersionJson } from './pwa';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

describe('PWA activation metadata', () => {
	it('uses the plain notifications route when no activation params are present', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications');
	});

	it('requests standalone install chrome without fullscreen overrides', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as {
			display: string;
			display_override: string[];
		};

		expect(manifest.display).toBe('standalone');
		expect(manifest.display_override).toEqual(['standalone', 'minimal-ui']);
	});

	it('carries activation params into the manifest start URL', () => {
		const manifest = JSON.parse(createManifestJson(
			'https://worker.test/notifications/manifest.json?token=install-token&folder=Reminders&upcomingDays=14&allDayTime=09%3A30&v=asset',
		)) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications?token=install-token&folder=Reminders&upcomingDays=14&allDayTime=09%3A30');
	});

	it('can carry the safe-area debug flag into the manifest start URL', () => {
		const manifest = JSON.parse(createManifestJson(
			'https://worker.test/notifications/manifest.json?token=install-token&folder=Reminders&debugSafeArea=1&v=asset',
		)) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications?token=install-token&folder=Reminders&debugSafeArea=1');
	});

	it('links the page to an activation-aware manifest', () => {
		const html = createPwaHtml('https://worker.test/notifications?token=install-token&folder=Reminders&upcomingDays=7');

		expect(html).toContain('<link rel="manifest" href="/notifications/manifest.json?token=install-token&folder=Reminders&upcomingDays=7&v=');
	});

	it('disables page zoom in the PWA shell', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('maximum-scale=1, user-scalable=no');
		expect(html).toContain("document.addEventListener('gesturestart', blockZoom, { passive: false })");
		expect(html).toContain("document.addEventListener('gesturechange', blockZoom, { passive: false })");
		expect(html).toContain("document.addEventListener('gestureend', blockZoom, { passive: false })");
	});

	it('exposes the current PWA asset version', () => {
		expect(JSON.parse(createPwaVersionJson())).toEqual({ assetVersion: PWA_ASSET_VERSION });
	});

	it('keeps standalone safe areas outside visible navigation chrome', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('height=device-height');
		expect(html).not.toContain('apple-mobile-web-app-status-bar-style');
		expect(html).toContain('html,body{margin:0;padding:0;background:linear-gradient(180deg,#131820 0%,#0c0f14 44%,#090a0d 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",system-ui,sans-serif;height:100%;overflow:hidden;overscroll-behavior:none;color-scheme:dark}');
		expect(html).toContain('body{width:100%;min-height:100%;overflow:hidden}');
		expect(html).toContain('#app{height:100%;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:hidden}');
		expect(html).toContain('.reminders-shadow-root{height:100%;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:visible;');
		expect(html).toContain('.pwa-reminders-view{position:fixed;inset:0;flex:1;min-height:0;width:100%;max-width:100vw;height:auto;display:flex;flex-direction:column;overflow:visible;');
		expect(html).toContain('--pwa-tabbar-content-height:64px');
		expect(html).toContain('--pwa-tabbar-safe-area:env(safe-area-inset-bottom)');
		expect(html).toContain('--reminders-tabbar-height:calc(var(--pwa-tabbar-content-height) + var(--pwa-tabbar-safe-area))');
		expect(html).toContain('--reminders-tabbar-overlay:var(--reminders-tabbar-height)');
		expect(html).toContain('--pwa-tabbar-bleed:0px');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none}');
		expect(html).toContain('display:flex!important;align-items:center;justify-content:space-around;width:100%;height:var(--pwa-tabbar-content-height);max-width:42rem!important;margin:0 auto!important;padding:0!important');
		expect(html).toContain('height:100%!important;min-height:0!important;padding:0!important');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar [data-action="switch-tab"]>div:last-child{transform:none}');
		expect(html).toContain('bottom:calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) - var(--pwa-tabbar-bleed))');
		expect(html).toContain('position:relative;bottom:auto;left:auto;right:auto;flex-shrink:0;margin-bottom:0;transform:none');
		expect(html).toContain('.pwa-reminders-view .premium-back-button{margin-top:calc(env(safe-area-inset-top) + 12px)}');
		expect(html).not.toContain('@supports (-webkit-touch-callout: none)');
		expect(html).not.toContain('bottom:calc(0px - env(safe-area-inset-bottom))');
		expect(html).not.toContain('bottom:calc(var(--pwa-tabbar-safe-area) * -1)');
		expect(html).not.toContain('bottom:calc(0px - var(--pwa-tabbar-safe-area))');
		expect(html).not.toContain('padding-bottom:max(env(safe-area-inset-bottom),16px)');
	});

	it('lets reminder sheets tuck under the keyboard while keeping settings above it', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('--keyboard-sheet-offset:0px');
		expect(html).toContain('--keyboard-sheet-overlap:0px');
		expect(html).toContain('.pwa-reminder-editor-backdrop{align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-sheet-offset,var(--keyboard-offset));');
		expect(html).toContain('.settings-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-offset);');
		expect(html).toContain('.pwa-keyboard-open .pwa-editor-description-input{flex:0 1 auto;min-height:42px;max-height:88px}');
	});

	it('includes safe area debug overlay styles for real-device measurement', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('.pwa-safe-area-debug{position:fixed;top:calc(env(safe-area-inset-top) + 8px);');
		expect(html).toContain('.pwa-safe-area-debug__row{display:grid;grid-template-columns:86px minmax(0,1fr);');
	});
});
