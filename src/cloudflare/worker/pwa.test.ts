import { describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import {
	OPEN_OBSIDIAN_HTML,
	OPEN_OBSIDIAN_JS,
	PWA_THEME_BOOTSTRAP_JS,
	SERVICE_WORKER_JS,
	createManifestJson,
	createPwaHtml,
	createPwaVersionJson,
} from './pwa';
import { PWA_ASSET_VERSION } from './pwa-version';
import { PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from './pwa/pwa-params';

describe('PWA activation metadata', () => {
	it('uses the plain notifications route when no activation params are present', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as { start_url: string };

		expect(manifest.start_url).toBe('/notifications');
	});

	it('provides light and dark launch colors', () => {
		const manifest = JSON.parse(createManifestJson('https://worker.test/notifications/manifest.json?v=asset')) as {
			background_color: string;
			color_scheme_dark: { background_color: string; theme_color: string };
			display: string;
			display_override: string[];
			theme_color: string;
		};

		expect(manifest.display).toBe('standalone');
		expect(manifest.display_override).toEqual(['standalone', 'minimal-ui']);
		expect(manifest.background_color).toBe(PWA_LIGHT_CHROME_COLOR);
		expect(manifest.theme_color).toBe(PWA_LIGHT_CHROME_COLOR);
		expect(manifest.color_scheme_dark).toEqual({
			background_color: PWA_CHROME_COLOR,
			theme_color: PWA_CHROME_COLOR,
		});
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
			icons: Array<{ sizes: string; purpose: string; src: string; type: string }>;
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
		expect(manifest.icons).toEqual([
			{
				src: `/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}`,
				sizes: '180x180',
				type: 'image/png',
				purpose: 'any',
			},
			{
				src: `/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}`,
				sizes: '192x192',
				type: 'image/png',
				purpose: 'any',
			},
			{
				src: `/notifications/crate-icon-512.png?v=${PWA_ASSET_VERSION}`,
				sizes: '512x512',
				type: 'image/png',
				purpose: 'any maskable',
			},
		]);
	});

	it('links the page to an activation-aware manifest', () => {
		const html = createPwaHtml('https://worker.test/notifications?token=install-token&browserToken=browser-token&folder=Reminders&upcomingDays=7');

		expect(html).toContain('<link rel="manifest" href="/notifications/manifest.json?token=install-token&folder=Reminders&upcomingDays=7&v=');
		expect(html).not.toContain('browserToken=browser-token');
	});

	it('keeps the PWA viewport fitted while allowing user zoom', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('width=device-width, initial-scale=1, viewport-fit=cover');
		expect(html).not.toContain('maximum-scale=1');
		expect(html).not.toContain('user-scalable=no');
		expect(html).not.toContain('height=device-height');
	});

	it('uses shared selection tokens and a violet action accent', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('--interactive-accent:#8b5cf6;');
		expect(html).toContain('--interactive-accent-hover:#9b75f7;');
		expect(html).toContain('--accent:#8b5cf6;');
		expect(html).toContain('--accent-rgb:139,92,246;');
		expect(html).toContain('--accent-strong:#8b5cf6;');
		expect(html).toContain('.crate-reminders-ui .bottom-tab-button {');
		expect(html).toContain('color: var(--crate-tab-active-color, var(--interactive-accent));');
		expect(html).toContain('--crate-tab-active-color: var(--crate-selection-color);');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-content{width:100%;height:100%;justify-content:center}');
		expect(html).toContain('.crate-reminders-ui .bottom-tab-icon {');
		expect(html).toContain('contain: paint;');
		expect(html).toContain('.crate-reminders-ui .bottom-tab-icon svg {');
		expect(html).not.toContain('.pwa-reminders-view .bottom-tab-button.is-active svg{');
		expect(html).toContain('.crate-reminders-ui .bottom-tab-label {');
		expect(html).toContain('.crate-reminders-ui .reminders-view.is-primary .reminders-fab {');
		expect(html).toContain('--crate-fab-bg: var(--crate-accent);');
		expect(html).toContain('.pwa-header-settings-button{position:relative;width:44px;height:44px;min-width:44px;border-radius:50%;');
		expect(html).toContain('--crate-icon-button-size: 44px;');
		expect(html).toContain('.crate-reminders-ui .crate-icon-button {');
		expect(html).toContain('.pwa-modal-sheet .reminder-modal-header .reminder-modal-header-close {');
		expect(html).toContain('.pwa-reminders-view .completed-section-toggle{height:44px;min-height:44px}');
		expect(html).toContain('.crate-reminders-ui .reminder-modal-header-action:disabled {');
		expect(html).toContain('.crate-reminders-ui .reminder-modal-header-action[data-tone=danger].is-enabled {');
		expect(html).toContain('color: var(--crate-danger);');
		expect(html).not.toContain('--interactive-accent:#a78bfa');
		expect(html).not.toContain('--accent:#9b7cff');
		expect(html).not.toContain('--accent-strong:#8e7cf4');
	});

	it('exposes the current PWA asset version', () => {
		expect(JSON.parse(createPwaVersionJson())).toEqual({ assetVersion: PWA_ASSET_VERSION });
	});

	it('keeps standalone safe areas outside visible navigation chrome', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('<html lang="en">');
		expect(html).toContain('<meta name="color-scheme" content="light dark">');
		expect(html).toContain(`<meta id="pwa-theme-color" name="theme-color" content="${PWA_CHROME_COLOR}" media="(prefers-color-scheme: dark)">`);
		expect(html).toContain(`<meta name="theme-color" content="${PWA_LIGHT_CHROME_COLOR}" media="(prefers-color-scheme: light)">`);
		expect(html).toContain(':root{--pwa-launch-bg:#0b0b0d;color-scheme:dark}');
		expect(html).toContain('html,body,#app{background-color:#0b0b0d;color-scheme:dark}');
		expect(html).toContain('@media (prefers-color-scheme: light){:root{--pwa-launch-bg:#f7f7f8;color-scheme:light}html,body,#app{background-color:#f7f7f8;color-scheme:light}}');
		expect(html).toContain('<body>');
		expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
		expect(html).toContain('<style id="pwa-light-theme" media="(prefers-color-scheme: light)">');
		expect(html).toContain('<script defer src="/notifications/theme-bootstrap.js?v=');
		expect(html).not.toContain('<script>');
		expect(PWA_THEME_BOOTSTRAP_JS).toContain('localStorage.getItem("crate-reminders-theme")');
		expect(PWA_THEME_BOOTSTRAP_JS).toContain("lightTheme.media=preference==='light'?'all':preference==='dark'?'not all':\"(prefers-color-scheme: light)\"");
		expect(PWA_THEME_BOOTSTRAP_JS).toContain("themeColor.setAttribute('media','all')");
		expect(html).toContain('<link rel="icon" type="image/png" sizes="192x192" href="/notifications/crate-icon-192.png?v=');
		expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=');
		expect(html).not.toContain('apple-touch-startup-image');
		expect(PWA_THEME_BOOTSTRAP_JS).toContain('(prefers-color-scheme: light)');
		expect(PWA_THEME_BOOTSTRAP_JS).toContain("preference==='dark'?'not all'");
		expect(html.indexOf('/notifications/theme-bootstrap.js')).toBeLessThan(html.indexOf('<body>'));
		expect(html.indexOf('/notifications/theme-bootstrap.js')).toBeLessThan(html.indexOf('<div id="app"><div class="pwa-launch-splash"'));
		expect(html).toContain('--pwa-launch-bg:#f7f7f8;');
		expect(html).toContain('<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">');
		expect(html).toContain('height:100%;height:100dvh;overflow:hidden;overscroll-behavior:none;color-scheme:dark}');
		expect(html).toContain('body{min-height:100%;min-height:100dvh;overflow:hidden}');
		expect(html).toContain('button{cursor:pointer;border:none;background:transparent;color:inherit;user-select:none;-webkit-user-select:none}');
		expect(html).toContain('#app,#app *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}');
		expect(html).toContain('#app input,#app textarea,#app [contenteditable="true"],#app [contenteditable="true"] *{user-select:text;-webkit-user-select:text;-webkit-touch-callout:default}');
		expect(html).toContain('#app{height:100%;height:100dvh;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:hidden}');
		expect(html).toContain('@media (display-mode:standalone){html,body{height:100vh;min-height:100vh}#app{height:100vh}}');
		expect(html).toContain('.reminders-shadow-root{height:100%;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:hidden;');
		expect(html).toContain('.pwa-shadow-root>[data-overlay-container="true"]{display:flex;flex:1;min-height:0;width:100%;height:100%;flex-direction:column;overflow:hidden}');
		expect(html).toContain('.crate-reminders-ui.pwa-shadow-root .pwa-reminders-view{flex:1;min-height:0;width:100%;max-width:100vw;height:100%;display:flex;flex-direction:column;');
		expect(html).toContain('.crate-reminders-ui.pwa-shadow-root .pwa-reminders-view.is-modal.is-fullscreen .animated-tab-bar-bottom{margin-bottom:0}');
		expect(html).toContain('--pwa-tabbar-content-height:64px');
		expect(html).toContain('--pwa-tabbar-safe-area:var(--pwa-safe-area-bottom)');
		expect(html).toContain('--pwa-tabbar-content-offset:min(4px,var(--pwa-tabbar-safe-area))');
		expect(html).toContain('--reminders-tabbar-height:calc(var(--pwa-tabbar-content-height) + var(--pwa-tabbar-safe-area));--reminders-tabbar-overlay:0px');
		expect(html).toContain('.crate-reminders-ui.pwa-shadow-root .pwa-reminders-view.is-modal.is-fullscreen{--reminders-tabbar-overlay:0px;');
		expect(html).toContain('--pwa-tabbar-bleed:0px');
		expect(html).toContain('.pwa-reminders-view .reminders-view-scroll{overflow-anchor:none}');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none;');
		expect(html).toContain('border-top:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.065)');
		expect(html).not.toContain('.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none;background:rgba(13,13,15,.9);backdrop-filter:blur(28px) saturate(150%);-webkit-backdrop-filter:blur(28px) saturate(150%);border-top:1px');
		expect(html).toContain('display:flex!important;align-items:center;justify-content:space-around;width:100%;height:var(--pwa-tabbar-content-height);max-width:42rem!important;margin:0 auto!important;padding:0!important;transform:translate3d(0,var(--pwa-tabbar-content-offset),0)!important');
		expect(html).toContain('.crate-reminders-ui .bottom-tab-slider-track {');
		expect(html).toContain('inset: 6px 8px;');
		expect(html).toContain('.crate-reminders-ui .bottom-tab-slider {');
		expect(html).toContain('height:100%!important;min-height:0!important;padding:0!important');
		expect(html).toContain('padding:0!important;transform:none!important');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar [data-action="switch-tab"]>div:last-child{transform:none}');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-button:active .bottom-tab-icon{transform:scale(.88)}');
		expect(html).toContain('@media (prefers-reduced-motion:reduce){.pwa-reminders-view .bottom-tab-icon{transition:none}');
		expect(html).toContain('bottom:calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) - var(--pwa-tabbar-bleed))');
		expect(html).toContain('.pwa-header-settings-button{position:relative;width:44px;height:44px;min-width:44px;');
		expect(html).toContain('.pwa-reminders-view .ios-scroll{scrollbar-width:none;overscroll-behavior-y:contain}');
		expect(html).toContain('position:relative;bottom:auto;left:auto;right:auto;flex-shrink:0;margin-bottom:0;transform:none');
		expect(html).toContain('--pwa-safe-area-top:max(env(safe-area-inset-top),env(safe-area-max-inset-top,0px))');
		expect(html).toContain('@media (display-mode:standalone) and (orientation:portrait) and (max-width:600px){:root{--pwa-safe-area-top-floor:59px;--pwa-safe-area-top:max(env(safe-area-inset-top),env(safe-area-max-inset-top,0px),var(--pwa-safe-area-top-floor));--pwa-safe-area-bottom-floor:34px;--pwa-safe-area-bottom:max(env(safe-area-inset-bottom),env(safe-area-max-inset-bottom,0px),var(--pwa-safe-area-bottom-floor))}}');
		expect(html).toContain('.pwa-reminders-view .view-header{max-width:100vw;overflow:hidden;padding:calc(var(--pwa-safe-area-top) + 17px)');
		expect(html).toContain('.pwa-reminders-view .premium-back-button{margin-top:calc(var(--pwa-safe-area-top) + 12px)}');
		expect(html).not.toContain('@supports (-webkit-touch-callout: none)');
		expect(html).not.toContain('bottom:calc(0px - env(safe-area-inset-bottom))');
		expect(html).not.toContain('bottom:calc(var(--pwa-tabbar-safe-area) * -1)');
		expect(html).not.toContain('bottom:calc(0px - var(--pwa-tabbar-safe-area))');
		expect(html).not.toContain('padding-bottom:max(env(safe-area-inset-bottom),16px)');
		expect(html).not.toContain('pwa-safe-area-debug');
	});

	it('provides readable light-theme styles for every PWA surface', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('--text-muted:#52525b;');
		expect(html).toContain('--text-faint:#66666f;');
		expect(html).toContain('--text-error:#b42318;');
		expect(html).toContain('--text-warning:#92400e;');
		expect(html).toContain('--text-success:#166534;');
		expect(html).toContain('--interactive-accent:#6d28d9;');
		expect(html).toContain('--crate-reminder-card-bg: var(--crate-panel-bg);');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar,.crate-reminders-ui .pwa-reminders-view.is-fullscreen .bottom-tab-bar{background:var(--pwa-tabbar-surface);');
		expect(html).toContain('.pwa-modal-sheet{color:var(--text-normal);color-scheme:light}');
		expect(html).toContain('.crate-reminders-ui .reminder-editor-fields .reminder-title-input {');
		expect(html).toContain('color: var(--text-normal);');
		expect(html).toContain('.crate-reminders-ui .premium-reminder-card.is-completed .premium-reminder-content {\n  opacity: 0.6;');
		expect(html).toContain('.settings-theme-option.is-active{background:var(--pwa-light-surface);color:var(--pwa-light-accent-text);');
	});

	it('keeps the Obsidian handoff page readable in light mode', () => {
		expect(OPEN_OBSIDIAN_HTML).toContain('<meta name="color-scheme" content="light dark">');
		expect(OPEN_OBSIDIAN_HTML).toContain('@media (prefers-color-scheme:light)');
		expect(OPEN_OBSIDIAN_HTML).toContain('body{background:#f7f7f8;color:#18181b}');
		expect(OPEN_OBSIDIAN_HTML).toContain('.btn{background:#6d28d9;color:#fff}');
		expect(OPEN_OBSIDIAN_HTML).toContain('p{color:#52525b}');
		expect(OPEN_OBSIDIAN_HTML).toContain('<script src="/notifications/open-obsidian.js?v=');
		expect(OPEN_OBSIDIAN_HTML).not.toContain('<script>');
		expect(OPEN_OBSIDIAN_JS).toContain("var project = params.get('project')");
	});

	it('keeps sheet containers fixed while pickers fit their content', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('.pwa-shadow-root.has-open-sheet .reminders-content,.pwa-shadow-root.has-open-sheet .reminders-view-scroll{overflow:hidden!important;overscroll-behavior:none!important;touch-action:none!important}');
		expect(html).toContain('.pwa-modal-sheet__backdrop{border:0;background:rgba(0,0,0,.66);backdrop-filter:blur(10px);');
		expect(html).not.toContain('.pwa-modal-sheet.is-screen-transition-closing .pwa-modal-sheet__backdrop');
		expect(html).not.toContain('backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);transition:opacity');
		expect(html).toContain('.pwa-modal-sheet__container--reminder{width:min(1120px,calc(100vw - 36px))!important;height:calc(100% - env(safe-area-inset-top) - 28px)!important;');
		expect(html).toContain('.pwa-modal-sheet__container--reminder,.pwa-modal-sheet__container--settings{max-height:90dvh!important}');
		expect(html).toContain('.pwa-modal-sheet.is-keyboard-open .pwa-reminder-sheet-stage{height:calc(100% - var(--pwa-keyboard-inset,0px));flex:0 0 calc(100% - var(--pwa-keyboard-inset,0px))}');
		expect(html).not.toContain('.pwa-modal-sheet.is-keyboard-open .pwa-modal-sheet__container--reminder{bottom:');
		expect(html).toContain('.pwa-modal-sheet__content,.pwa-modal-sheet__scroller{height:100%;min-height:0;overflow:hidden!important}');
		expect(html).toContain('.pwa-picker-sheet{position:relative;z-index:1;display:flex;width:100%;height:auto;');
		expect(html).toContain('.crate-reminders-ui .reminder-date-picker .picker-schedule-fields {');
		expect(html).toContain('.crate-reminders-ui .project-picker-row {');
		expect(html).toContain('.crate-reminders-ui .recurrence-frequency-tabs {');
		expect(html).not.toContain('@keyframes pwa-nested-sheet-in');
		expect(html).toContain('.pwa-modal-sheet--settings .settings-sheet{position:relative;display:flex;width:100%;max-height:calc(100dvh - env(safe-area-inset-top) - 28px);min-height:0;overflow:hidden;flex-direction:column;background:var(--pwa-sheet-surface);');
		expect(html).not.toContain('.pwa-modal-sheet--settings .settings-sheet{position:relative;display:flex;width:100%;max-height:calc(100dvh - env(safe-area-inset-top) - 28px);min-height:0;overflow:hidden;flex-direction:column;background:#0f0f12;');
		expect(html).toContain('.settings-panel{display:flex;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;');
		expect(html).toContain('.crate-reminders-ui .modal-card.pwa-reminder-editor .modal-form {');
		expect(html).toContain('.crate-reminders-ui .modal-card.pwa-reminder-editor .reminder-modal-body {');
		expect(html).toContain('overflow-y: auto;');
		expect(html).toContain('overscroll-behavior: contain;');
		expect(html).toContain('height: min(var(--pwa-editor-content-height, 224px) + env(safe-area-inset-bottom), 100%);');
		expect(html).toContain('height: min(var(--pwa-editor-content-height, 224px) + 16px + var(--pwa-keyboard-inset, 0px), 100%);');
		expect(html).toContain('--reminder-font-base: 16px;');
		expect(html).toContain('.crate-reminders-ui .reminder-description-input {');
		expect(html).toContain('max-height: 108px;');
		expect(html).toContain('.crate-reminders-ui .reminder-action-chip {');
		expect(html).not.toContain('.pwa-editor-card{');
		expect(html).not.toContain('.pwa-editor-chip{');
		expect(html).not.toContain('transition:padding-bottom');
		expect(html).not.toContain('pwa-reminder-editor-backdrop');
		expect(html).not.toContain('--keyboard-usable-height');
		expect(html).toContain('box-shadow:0 -1px 0 rgba(255,255,255,.025),0 -24px 70px rgba(0,0,0,.28)');
		expect(html).not.toContain('box-shadow:0 -6px 20px rgba(0,0,0,.22)');
		expect(html).not.toContain('box-shadow:0 -12px 48px rgba(0,0,0,.38)');
	});

	it('uses native-feeling sheet and list interaction affordances', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).not.toContain('pwa-sheet-grabber');
		expect(html).not.toContain('--pwa-sheet-drag-');
		expect(html).toContain('.crate-reminders-ui .reorderable-reminder-item[data-reorder-interaction] {');
		expect(html).toContain('.crate-reminders-ui .reorderable-reminder-item[data-reorder-interaction]:is(.is-long-press-armed, .is-reordering) :is(.premium-reminder-content, .reminder-card__main)');
		expect(html).toContain('--crate-reminder-card-hover-shadow: none;');
		expect(html).not.toContain('transform:scale(1.025)');
		expect(html).toContain('.crate-reminders-ui .premium-checkbox {');
		expect(html).toContain('box-shadow: var(--crate-checkbox-checked-shadow, none);');
		expect(html).toContain('.pwa-reminders-view .premium-checkbox.is-completing .premium-checkbox-visual{animation:pwa-completion-check 360ms cubic-bezier(.16,1,.3,1)}');
		expect(html).toContain('@keyframes pwa-completion-check{0%{transform:scale(.92)}55%{transform:scale(1.14)}100%{transform:scale(1)}}');
		expect(html).toContain('--reminders-fab-gap:16px;--reminders-fab-size:44px;');
		expect(html).toContain('.pwa-reminders-view .reminders-fab{position:absolute;bottom:');
		expect(html).not.toContain('.pwa-header-add-button');
		expect(html).toContain('.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none;background:rgba(13,13,15,.9);');
	});

	it('ships an offline-capable installed app shell service worker', () => {
		expect(() => new Script(SERVICE_WORKER_JS)).not.toThrow();
		expect(SERVICE_WORKER_JS.endsWith('`')).toBe(false);
		expect(SERVICE_WORKER_JS).toContain("const PWA_SHELL_CACHE = 'crate-reminders-shell-");
		expect(SERVICE_WORKER_JS).toContain("const PWA_SHELL_URL = '/notifications'");
		expect(SERVICE_WORKER_JS).toContain("cache.addAll(PWA_PRECACHE_URLS)");
		expect(SERVICE_WORKER_JS).not.toContain('apple-startup');
		expect(SERVICE_WORKER_JS).toContain("url.pathname === PWA_SHELL_URL");
		expect(SERVICE_WORKER_JS).toContain("return cache.match(PWA_SHELL_URL)");
		expect(SERVICE_WORKER_JS).toContain('collectUnusedShellCaches');
		expect(SERVICE_WORKER_JS.indexOf("cache.match(PWA_SHELL_URL)")).toBeLessThan(
			SERVICE_WORKER_JS.indexOf('return fetch(event.request)'),
		);
		expect(SERVICE_WORKER_JS).toContain("url.pathname === '/notifications/app.js'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname.indexOf('/notifications/assets/') === 0");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/theme-bootstrap.js'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/icon.svg'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/crate-icon-192.png'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/crate-icon-512.png'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/crate-mark-256.png'");
		expect(SERVICE_WORKER_JS).toContain("|| url.pathname === '/notifications/apple-touch-icon-180.png'");
	});

	it('does not replace the Obsidian handoff navigation with the cached app shell', () => {
		type FetchEvent = {
			request: { method: string; mode: string; url: string };
			respondWith: (response: Promise<Response>) => void;
		};
		const fetchHandlers: Array<(event: FetchEvent) => void> = [];
		const self = {
			location: { origin: 'https://worker.test' },
			addEventListener: (type: string, handler: (event: never) => void) => {
				if (type === 'fetch') fetchHandlers.push(handler as (event: FetchEvent) => void);
			},
			skipWaiting: vi.fn(),
			clients: { claim: vi.fn() },
		};
		new Script(SERVICE_WORKER_JS).runInNewContext({
			URL,
			URLSearchParams,
			Response,
			caches: {
				keys: vi.fn().mockResolvedValue([]),
				open: vi.fn().mockResolvedValue({
					addAll: vi.fn().mockResolvedValue(undefined),
					match: vi.fn().mockResolvedValue(new Response('shell')),
					put: vi.fn().mockResolvedValue(undefined),
				}),
				match: vi.fn().mockResolvedValue(undefined),
			},
			clients: {
				matchAll: vi.fn().mockResolvedValue([]),
				openWindow: vi.fn(),
			},
			fetch: vi.fn(),
			self,
		});
		const fetchHandler = fetchHandlers[0];
		expect(fetchHandler).toBeDefined();

		const handoffRespondWith = vi.fn();
		fetchHandler?.({
			request: {
				method: 'GET',
				mode: 'navigate',
				url: 'https://worker.test/notifications/open-obsidian?project=Work',
			},
			respondWith: handoffRespondWith,
		});
		expect(handoffRespondWith).not.toHaveBeenCalled();

		const shellRespondWith = vi.fn();
		fetchHandler?.({
			request: {
				method: 'GET',
				mode: 'navigate',
				url: 'https://worker.test/notifications?project=Work',
			},
			respondWith: shellRespondWith,
		});
		expect(shellRespondWith).toHaveBeenCalledOnce();
	});

	it('ships parseable external scripts under the strict PWA CSP', () => {
		expect(() => new Script(PWA_THEME_BOOTSTRAP_JS)).not.toThrow();
		expect(() => new Script(OPEN_OBSIDIAN_JS)).not.toThrow();
		expect(OPEN_OBSIDIAN_HTML.endsWith('`')).toBe(false);
	});

	it('deep links notification clicks to the reminder and project', () => {
		expect(SERVICE_WORKER_JS).toContain("var reminderId = notificationData.reminderId || ''");
		expect(SERVICE_WORKER_JS).toContain("if (project) params.set('project', project)");
		expect(SERVICE_WORKER_JS).toContain("if (reminderId) params.set('reminderId', reminderId)");
		expect(SERVICE_WORKER_JS).toContain("var url = notificationData.navigate || '/notifications'");
		expect(SERVICE_WORKER_JS).toContain("clients.matchAll({ type: 'window', includeUncontrolled: true })");
		expect(SERVICE_WORKER_JS).toContain('return client.navigate(url)');
		expect(SERVICE_WORKER_JS).toContain('return (navigatedClient || client).focus()');
		expect(SERVICE_WORKER_JS).toContain('return clients.openWindow(url)');
	});

	it('supports declarative push with a fallback notification handler', () => {
		expect(SERVICE_WORKER_JS).toContain('var notification = payload.notification || payload');
		expect(SERVICE_WORKER_JS).toContain("navigate: notification.navigate || ''");
	});

	it('hands off from the native launch surface to one static app splash', () => {
		const html = createPwaHtml('https://worker.test/notifications');

		expect(html).toContain('<div id="app"><div class="pwa-launch-splash" role="status" aria-label="Loading Crate"></div></div>');
		expect(html).toContain('.pwa-launch-splash{width:100%;height:100%;overflow:hidden;background:var(--pwa-launch-bg)}');
		expect(html).not.toContain('pwa-launch-splash__label');
		expect(html).not.toContain('pwa-bootstrap');
		expect(html).not.toContain('pwa-skeleton');
		expect(html).not.toContain('apple-touch-startup-image');
	});

});
