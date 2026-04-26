import { describe, expect, it } from 'vitest';
import { createManifestJson, createPwaHtml, createPwaVersionJson } from './pwa';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

describe('PWA activation metadata', () => {
	it('uses the plain notifications route when no activation params are present', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications');
	});

	it('carries activation params into the manifest start URL', () => {
		const manifest = JSON.parse(createManifestJson(
			'https://worker.test/notifications/manifest.json?token=install-token&folder=Reminders&upcomingDays=14&allDayTime=09%3A30&v=asset',
		)) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications?token=install-token&folder=Reminders&upcomingDays=14&allDayTime=09%3A30');
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

		expect(html).toContain('bottom:0;left:0;right:0;flex-shrink:0;margin-bottom:0;transform:translate3d(0,env(safe-area-inset-bottom),0)');
		expect(html).toContain('.pwa-reminders-view .premium-back-button{margin-top:calc(env(safe-area-inset-top) + 12px)}');
		expect(html).not.toContain('bottom:calc(var(--pwa-tabbar-safe-area) * -1)');
		expect(html).not.toContain('bottom:calc(0px - var(--pwa-tabbar-safe-area))');
	});
});
