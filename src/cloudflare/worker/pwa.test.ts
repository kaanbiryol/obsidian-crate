import { describe, expect, it } from 'vitest';
import { SERVICE_WORKER_JS, createManifestJson, createPwaHtml, createPwaVersionJson } from './pwa';
import { PWA_ASSET_VERSION } from './pwa-version';

describe('PWA activation metadata', () => {
	it('uses the plain notifications route when no activation params are present', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications');
	});

	it('requests standalone install chrome without fullscreen overrides', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as {
			display: string;
			display_override: string[];
			background_color: string;
			theme_color: string;
		};

		expect(manifest.display).toBe('standalone');
		expect(manifest.display_override).toEqual(['standalone', 'minimal-ui']);
		expect(manifest.background_color).toBe('#1e1e1e');
		expect(manifest.theme_color).toBe('#1e1e1e');
	});

	it('carries activation params into the manifest start URL', () => {
		const manifest = JSON.parse(createManifestJson(
			'https://worker.test/notifications/manifest.json?token=install-token&folder=Reminders&upcomingDays=14&allDayTime=09%3A30&tab=today&v=asset',
		)) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications?token=install-token&folder=Reminders&upcomingDays=14&allDayTime=09%3A30&tab=today');
	});

	it('adds mobile launcher metadata and shortcuts', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as {
			categories: string[];
			launch_handler: { client_mode: string };
			shortcuts: Array<{ name: string; url: string }>;
		};

		expect(manifest.categories).toEqual(['productivity', 'utilities']);
		expect(manifest.launch_handler.client_mode).toBe('navigate-existing');
		expect(manifest.shortcuts.map((shortcut) => [shortcut.name, shortcut.url])).toEqual([
			['Inbox', '/notifications'],
			['Today', '/notifications?tab=today'],
			['Upcoming', '/notifications?tab=upcoming'],
		]);
	});

	it('links the page to an activation-aware manifest', () => {
		const html = createPwaHtml('https://worker.test/notifications?token=install-token&folder=Reminders&upcomingDays=7');

		expect(html).toContain('<link rel="manifest" href="/notifications/manifest.json?token=install-token&folder=Reminders&upcomingDays=7&v=');
	});

	it('locks the PWA shell to the native app scale', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
		expect(html).not.toContain('height=device-height');
	});

	it('exposes the current PWA asset version', () => {
		expect(JSON.parse(createPwaVersionJson())).toEqual({ assetVersion: PWA_ASSET_VERSION });
	});

	it('keeps standalone safe areas outside visible navigation chrome', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
		expect(html).toContain('<meta name="theme-color" content="#1e1e1e">');
		expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=');
		expect(html).toContain('<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1179x2556.png?v=');
		expect(html).toContain('<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1290x2796.png?v=');
		expect(html).toContain('<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">');
		expect(html).toContain('height:100%;height:100dvh;overflow:hidden;overscroll-behavior:none;color-scheme:dark}');
		expect(html).toContain('body{min-height:100%;min-height:100dvh;overflow:hidden;touch-action:manipulation}');
		expect(html).toContain('button{cursor:pointer;border:none;background:transparent;color:inherit;touch-action:manipulation;user-select:none;-webkit-user-select:none}');
		expect(html).toContain('#app{height:100%;height:100dvh;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:hidden}');
		expect(html).toContain('.reminders-shadow-root{height:100%;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:hidden;');
		expect(html).toContain('.pwa-shadow-root>[data-overlay-container="true"]{display:flex;flex:1;min-height:0;width:100%;height:100%;flex-direction:column;overflow:hidden}');
		expect(html).toContain('.crate-reminders-ui.pwa-shadow-root .pwa-reminders-view{flex:1;min-height:0;width:100%;max-width:100vw;height:100%;display:flex;flex-direction:column;');
		expect(html).toContain('.crate-reminders-ui.pwa-shadow-root .pwa-reminders-view.is-modal.is-fullscreen .animated-tab-bar-bottom{margin-bottom:0}');
		expect(html).toContain('--pwa-tabbar-content-height:64px');
		expect(html).toContain('--pwa-tabbar-safe-area:env(safe-area-inset-bottom)');
		expect(html).toContain('--pwa-tabbar-content-offset:min(4px,var(--pwa-tabbar-safe-area))');
		expect(html).toContain('--reminders-tabbar-height:calc(var(--pwa-tabbar-content-height) + var(--pwa-tabbar-safe-area))');
		expect(html).toContain('--reminders-tabbar-overlay:var(--reminders-tabbar-height)');
		expect(html).toContain('--pwa-tabbar-bleed:0px');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none;');
		expect(html).toContain('display:flex!important;align-items:center;justify-content:space-around;width:100%;height:var(--pwa-tabbar-content-height);max-width:42rem!important;margin:0 auto!important;padding:0!important;transform:translate3d(0,var(--pwa-tabbar-content-offset),0)!important');
		expect(html).toContain('height:100%!important;min-height:0!important;padding:0!important');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar [data-action="switch-tab"]>div:last-child{transform:none}');
		expect(html).toContain('bottom:calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) - var(--pwa-tabbar-bleed))');
		expect(html).toContain('.pwa-header-settings-button,.pwa-header-sync-button{position:relative;width:44px;height:44px;min-width:44px;');
		expect(html).toContain('.pwa-reminders-view .ios-scroll{scrollbar-width:none;overscroll-behavior-y:contain}');
		expect(html).toContain('position:relative;bottom:auto;left:auto;right:auto;flex-shrink:0;margin-bottom:0;transform:none');
		expect(html).toContain('.pwa-reminders-view .premium-back-button{margin-top:calc(env(safe-area-inset-top) + 12px)}');
		expect(html).not.toContain('@supports (-webkit-touch-callout: none)');
		expect(html).not.toContain('bottom:calc(0px - env(safe-area-inset-bottom))');
		expect(html).not.toContain('bottom:calc(var(--pwa-tabbar-safe-area) * -1)');
		expect(html).not.toContain('bottom:calc(0px - var(--pwa-tabbar-safe-area))');
		expect(html).not.toContain('padding-bottom:max(env(safe-area-inset-bottom),16px)');
		expect(html).not.toContain('pwa-safe-area-debug');
	});

	it('keeps reminder sheet controls close to the keyboard while keeping settings above it', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('.pwa-reminder-editor-backdrop{align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-offset);');
		expect(html).toContain('.pwa-reminder-editor-backdrop::after{content:"";position:absolute;right:0;bottom:0;left:0;height:var(--keyboard-offset);background:var(--pwa-sheet-surface);');
		expect(html).toContain('html.pwa-keyboard-open,html.pwa-keyboard-open body{background:var(--pwa-sheet-surface)}');
		expect(html).toContain('.modal-card.pwa-reminder-editor.is-closing{pointer-events:none;animation:pwa-sheet-out .3s cubic-bezier(.4,0,1,1) forwards}');
		expect(html).toContain('.settings-sheet.is-closing{pointer-events:none;animation:pwa-sheet-out .3s cubic-bezier(.4,0,1,1) forwards}');
		expect(html).toContain('@keyframes pwa-backdrop-out{from{background-color:rgba(0,0,0,.56);backdrop-filter:blur(8px)}to{background-color:rgba(0,0,0,0);backdrop-filter:blur(0)}}');
		expect(html).toContain('.settings-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-offset);');
		expect(html).toContain('.pwa-reminder-editor .modal-form{gap:0;display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden}');
		expect(html).toContain('max-height:calc(var(--keyboard-usable-height,100dvh) - 72px);overflow:hidden;background:var(--pwa-sheet-surface)');
		expect(html).toContain('.pwa-keyboard-open .modal-card.pwa-reminder-editor{height:calc(var(--keyboard-usable-height,100dvh) - 72px);max-height:calc(var(--keyboard-usable-height,100dvh) - 72px);padding-bottom:16px}');
		expect(html).toContain('.pwa-editor-actions{flex:0 0 auto;min-width:0}');
		expect(html).toContain('.pwa-keyboard-open .pwa-editor-card{flex:1 1 auto;min-height:0;padding:16px 18px 18px}');
		expect(html).toContain('.pwa-keyboard-open .pwa-editor-description-input{flex:0 1 auto;min-height:42px;max-height:88px}');
		expect(html).toContain('.pwa-keyboard-open .pwa-editor-chip-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 44px 44px;gap:8px;margin-top:14px;padding-top:14px;overflow:visible}');
		expect(html).toContain('.pwa-keyboard-open .modal-card.pwa-reminder-editor{height:calc(var(--keyboard-usable-height,100dvh) - 28px);max-height:calc(var(--keyboard-usable-height,100dvh) - 28px);padding-bottom:16px}');
		expect(html).toContain('box-shadow:0 -1px 0 rgba(255,255,255,.035)');
		expect(html).not.toContain('box-shadow:0 -6px 20px rgba(0,0,0,.22)');
		expect(html).not.toContain('box-shadow:0 -12px 48px rgba(0,0,0,.38)');
	});

	it('uses native-feeling sheet and list interaction affordances', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('.pwa-sheet-grabber{width:100%;height:28px;min-height:28px;');
		expect(html).toContain('touch-action:none;cursor:grab;');
		expect(html).toContain('.reorderable-reminder-item[data-reorder-interaction="long-press"]{-webkit-touch-callout:none;user-select:none;');
		expect(html).toContain('.reorderable-reminder-item[data-reorder-interaction="long-press"].is-reordering .premium-reminder-content');
		expect(html).toContain('--reminders-fab-gap:18px;--reminders-fab-size:56px;');
		expect(html).toContain('.pwa-reminders-view .reminders-fab.fab{position:absolute;right:16px;');
		expect(html).not.toContain('.pwa-header-add-button');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none;background:rgba(30,30,30,.74);');
	});

	it('ships an offline-capable installed app shell service worker', () => {
		expect(SERVICE_WORKER_JS).toContain("const PWA_SHELL_CACHE = 'crate-reminders-shell-");
		expect(SERVICE_WORKER_JS).toContain("const PWA_SHELL_URL = '/notifications'");
		expect(SERVICE_WORKER_JS).toContain("cache.addAll(PWA_PRECACHE_URLS)");
		expect(SERVICE_WORKER_JS).toContain("event.request.mode === 'navigate' || url.pathname === PWA_SHELL_URL");
		expect(SERVICE_WORKER_JS).toContain("return caches.match(PWA_SHELL_URL).then(function(cached)");
		expect(SERVICE_WORKER_JS).toContain("url.pathname === '/notifications/app.js'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/icon.svg'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/apple-touch-icon-180.png'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/apple-startup-1179x2556.png'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/apple-startup-1290x2796.png'");
	});

	it('deep links notification clicks to the reminder and project', () => {
		expect(SERVICE_WORKER_JS).toContain("var reminderId = (event.notification.data && event.notification.data.reminderId) || ''");
		expect(SERVICE_WORKER_JS).toContain("if (project) params.set('project', project)");
		expect(SERVICE_WORKER_JS).toContain("if (reminderId) params.set('reminderId', reminderId)");
		expect(SERVICE_WORKER_JS).toContain("clients.openWindow(url)");
	});

});
