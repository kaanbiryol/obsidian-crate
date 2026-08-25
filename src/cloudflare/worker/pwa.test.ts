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

	it('uses the Obsidian purple for every PWA interaction accent', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('--interactive-accent:#7c3aed;');
		expect(html).toContain('--interactive-accent-hover:#7c3aed;');
		expect(html).toContain('--accent:#7c3aed;');
		expect(html).toContain('--accent-rgb:124,58,237;');
		expect(html).toContain('--accent-strong:#7c3aed;');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-button.is-active{color:var(--accent)}');
		expect(html).toContain('.pwa-reminders-view .reminders-fab.fab{position:absolute;right:16px;');
		expect(html).toContain('background:var(--accent);box-shadow:0 4px 12px rgba(var(--accent-rgb),.4)');
		expect(html).toContain('.pwa-editor-icon-button--save{background:var(--accent);');
		expect(html).not.toContain('--interactive-accent:#a78bfa');
		expect(html).not.toContain('--accent:#9b7cff');
		expect(html).not.toContain('--accent-strong:#8e7cf4');
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
		expect(html).toContain('#app,#app *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}');
		expect(html).toContain('#app input,#app textarea,#app [contenteditable="true"],#app [contenteditable="true"] *{user-select:text;-webkit-user-select:text;-webkit-touch-callout:default}');
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

	it('keeps library-backed sheets fixed while their inner fields handle scrolling', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('.pwa-shadow-root.has-open-sheet .reminders-content,.pwa-shadow-root.has-open-sheet .reminders-view-scroll{overflow:hidden!important;overscroll-behavior:none!important;touch-action:none!important}');
		expect(html).toContain('.pwa-modal-sheet__backdrop{border:0;background:rgba(0,0,0,.56);backdrop-filter:blur(8px);');
		expect(html).toContain('.pwa-modal-sheet__container--reminder{width:min(1120px,calc(100vw - 36px))!important;height:calc(100% - env(safe-area-inset-top) - 28px)!important;');
		expect(html).toContain('.pwa-modal-sheet.is-keyboard-open .pwa-reminder-sheet-stage{height:calc(100% - var(--pwa-keyboard-inset,0px));flex:0 0 calc(100% - var(--pwa-keyboard-inset,0px))}');
		expect(html).not.toContain('.pwa-modal-sheet.is-keyboard-open .pwa-modal-sheet__container--reminder{bottom:');
		expect(html).toContain('.pwa-modal-sheet__content,.pwa-modal-sheet__scroller{height:100%;min-height:0;overflow:hidden!important}');
		expect(html).toContain('.pwa-picker-sheet{position:relative;z-index:1;display:flex;width:100%;height:100%;');
		expect(html).toContain('.pwa-schedule-preset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}');
		expect(html).toContain('.pwa-schedule-fields{overflow:hidden;border:1px solid rgba(255,255,255,.07);border-radius:18px;');
		expect(html).toContain('.pwa-repeat-frequency-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}');
		expect(html).toContain('.pwa-repeat-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px;');
		expect(html).not.toContain('@keyframes pwa-nested-sheet-in');
		expect(html).toContain('.pwa-modal-sheet--settings .settings-sheet{position:relative;display:flex;width:100%;max-height:calc(100dvh - env(safe-area-inset-top) - 28px);min-height:0;overflow:hidden;');
		expect(html).toContain('.settings-panel{display:flex;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;');
		expect(html).toContain('.pwa-reminder-editor .modal-form{gap:0;display:flex;flex:1;min-height:0;flex-direction:column;overflow:hidden}');
		expect(html).toContain('.pwa-editor-card{position:relative;display:flex;flex:1 1 420px;min-height:160px;flex-direction:column;overflow:hidden;overscroll-behavior:none;');
		expect(html).toContain('.pwa-editor-actions{flex:0 0 auto;min-width:0}');
		expect(html).toContain('.pwa-modal-sheet.is-keyboard-open .pwa-editor-card{flex:1 1 auto;min-height:0;padding:16px 18px 18px}');
		expect(html).toContain('.pwa-editor-title-input{flex:1 1 0;min-height:42px;max-height:120px;');
		expect(html).toContain('.pwa-editor-description-input{flex:1.15 1 0;height:auto;min-height:60px;max-height:260px;');
		expect(html).toContain('.pwa-modal-sheet.is-keyboard-open .pwa-editor-title-input{flex:.9 1 0;min-height:42px;max-height:96px}');
		expect(html).toContain('.pwa-modal-sheet.is-keyboard-open .pwa-editor-description-input{flex:1.1 1 0;height:auto;min-height:42px;max-height:none}');
		expect(html).not.toContain('transition:padding-bottom');
		expect(html).toContain('.pwa-modal-sheet.is-keyboard-open .pwa-editor-chip-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-top:12px;padding:4px;overflow:visible}');
		expect(html).toContain('.pwa-editor-chip .pwa-editor-chip__mobile-label{display:block}');
		expect(html).not.toContain('pwa-reminder-editor-backdrop');
		expect(html).toContain('.pwa-editor-focus-bridge{position:fixed;top:calc(env(safe-area-inset-top) + 1px);left:1px;width:1px;height:1px;');
		expect(html).not.toContain('--keyboard-usable-height');
		expect(html).toContain('box-shadow:0 -1px 0 rgba(255,255,255,.035)');
		expect(html).not.toContain('box-shadow:0 -6px 20px rgba(0,0,0,.22)');
		expect(html).not.toContain('box-shadow:0 -12px 48px rgba(0,0,0,.38)');
	});

	it('uses native-feeling sheet and list interaction affordances', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).not.toContain('pwa-sheet-grabber');
		expect(html).not.toContain('--pwa-sheet-drag-');
		expect(html).toContain('.reorderable-reminder-item[data-reorder-interaction="long-press"]{-webkit-touch-callout:none;user-select:none;');
		expect(html).toContain('.reorderable-reminder-item[data-reorder-interaction="long-press"].is-reordering .premium-reminder-content');
		expect(html).toContain('box-shadow 280ms cubic-bezier(.16,1,.3,1)');
		expect(html).not.toContain('transform:scale(1.025)');
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
