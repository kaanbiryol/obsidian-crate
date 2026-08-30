import { PWA_ASSET_VERSION } from '../pwa-version';
import { manifestHrefForUrl, PWA_CHROME_COLOR } from './pwa-params';
import { PWA_LIGHT_THEME_STYLES, PWA_STYLES } from './styles';
import {
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
} from '../../../pwa/theme';

const BOOTSTRAP_ICON_ATTRIBUTES = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const BOOTSTRAP_ICONS = {
	refresh: `<svg ${BOOTSTRAP_ICON_ATTRIBUTES}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>`,
	settings: `<svg ${BOOTSTRAP_ICON_ATTRIBUTES}><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
	inbox: `<svg ${BOOTSTRAP_ICON_ATTRIBUTES}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>`,
	calendar: `<svg ${BOOTSTRAP_ICON_ATTRIBUTES}><path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path></svg>`,
	calendarRange: `<svg ${BOOTSTRAP_ICON_ATTRIBUTES}><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M16 2v4"></path><path d="M3 10h18"></path><path d="M8 2v4"></path><path d="M17 14h-6"></path><path d="M13 18H7"></path><path d="M7 14h.01"></path><path d="M17 18h.01"></path></svg>`,
	folder: `<svg ${BOOTSTRAP_ICON_ATTRIBUTES}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"></path></svg>`,
} as const;

const BOOTSTRAP_HEADER_ACTIONS = `<div class="pwa-bootstrap-header__actions"><span class="pwa-bootstrap-header__action">${BOOTSTRAP_ICONS.refresh}<i></i></span><span class="pwa-bootstrap-header__action">${BOOTSTRAP_ICONS.settings}</span></div>`;
const BOOTSTRAP_TABS = [
	['Inbox', BOOTSTRAP_ICONS.inbox],
	['Today', BOOTSTRAP_ICONS.calendar],
	['Upcoming', BOOTSTRAP_ICONS.calendarRange],
	['Projects', BOOTSTRAP_ICONS.folder],
].map(([label, icon], index) => `<span class="pwa-bootstrap-tab${index === 0 ? ' is-active' : ''}">${icon}<small>${label}</small></span>`).join('');

export function createPwaHtml(requestUrl?: string): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	const skeletonRow = '<div class="pwa-skeleton-row"><div class="pwa-skeleton-check"></div><div class="pwa-skeleton-body"><div class="pwa-skeleton-line"></div><div class="pwa-skeleton-line is-short"></div></div></div>';
	const skeletonRows = skeletonRow.repeat(5);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<style>
:root{--pwa-launch-bg:${PWA_CHROME_COLOR};color-scheme:dark}
html,body,#app{background-color:${PWA_CHROME_COLOR};color-scheme:dark}
</style>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta id="${PWA_THEME_COLOR_META_ID}" name="theme-color" content="${PWA_CHROME_COLOR}">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="icon" type="image/png" sizes="192x192" href="/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1206x2622.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1179x2556.png?v=${PWA_ASSET_VERSION}" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1206x2622.png?v=${PWA_ASSET_VERSION}" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<link rel="apple-touch-startup-image" href="/notifications/apple-startup-1290x2796.png?v=${PWA_ASSET_VERSION}" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
<title>Crate Reminders</title>
<style>
${PWA_STYLES}
</style>
<style id="${PWA_LIGHT_THEME_STYLE_ID}" media="not all">
${PWA_LIGHT_THEME_STYLES}
</style>
	<script src="/notifications/theme-bootstrap.js?v=${PWA_ASSET_VERSION}"></script>
</head>
<body>
	<div id="app"><div class="pwa-bootstrap-shell" role="status" aria-live="polite" aria-label="Loading reminders"><div class="pwa-bootstrap-header" aria-hidden="true"><div class="pwa-bootstrap-header__copy"><h1>Inbox</h1><div class="pwa-bootstrap-header__meta"></div></div>${BOOTSTRAP_HEADER_ACTIONS}</div><div class="pwa-bootstrap-content" aria-hidden="true"><div class="pwa-loading-state is-visible"><div class="pwa-skeleton-list">${skeletonRows}</div></div></div><div class="pwa-bootstrap-tabs" aria-hidden="true">${BOOTSTRAP_TABS}</div></div></div>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}
