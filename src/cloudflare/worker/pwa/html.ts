import { PWA_THEME_INIT_JS, PWA_THEME_STYLES_JS } from './theme-bootstrap';
import { PWA_STATUS_BAR_INIT_JS } from './status-bar-bootstrap';
import { PWA_ASSET_VERSION } from '../pwa-version';
import { PWA_STARTUP_ASSETS } from '../pwa-client-bundle';
import { manifestHrefForUrl, PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from './pwa-params';
import { PWA_LIGHT_THEME_STYLES, PWA_STYLES } from './styles';
import { PWA_OPENING_DOCK_INIT_JS } from '../../../pwa/opening-dock';
import { createPwaOpeningScreenHtml, PWA_OPENING_SCREEN_INIT_JS } from '../../../pwa/opening-screen';
import { createPwaUpdateScreenHtml } from '../../../pwa/update-screen';
import { CRATE_ICON_192_PNG } from './install-assets';
import {
	PWA_LIGHT_SCHEME_MEDIA,
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
} from '../../../pwa/theme';

// The reload curtain must paint its logo with the document, even before the
// service worker responds to image requests. Keep these bytes out of app.js.
const updateScreenHtml = createPwaUpdateScreenHtml(`data:image/png;base64,${btoa(Array.from(CRATE_ICON_192_PNG, byte => String.fromCharCode(byte)).join(''))}`);

export function createPwaHtml(requestUrl?: string, nonce: string = crypto.randomUUID()): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	return `<!DOCTYPE html>
<html lang="en" style="background:${PWA_CHROME_COLOR};background:light-dark(${PWA_LIGHT_CHROME_COLOR},${PWA_CHROME_COLOR});color-scheme:light dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- The root already paints the system palette before head metadata is parsed.
     Resolve the saved override before native launcher metadata and app startup. -->
<style>
:root{--pwa-launch-bg:${PWA_CHROME_COLOR};color-scheme:dark}
html,body,#app{background:var(--pwa-launch-bg);color-scheme:inherit}
@media ${PWA_LIGHT_SCHEME_MEDIA}{:root{--pwa-launch-bg:${PWA_LIGHT_CHROME_COLOR};color-scheme:light}}
</style>
<meta id="${PWA_THEME_COLOR_META_ID}" name="theme-color" content="${PWA_CHROME_COLOR}" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="${PWA_LIGHT_CHROME_COLOR}" media="${PWA_LIGHT_SCHEME_MEDIA}">
<script nonce="${nonce}" id="pwa-theme-init">${PWA_THEME_INIT_JS}</script>
<script nonce="${nonce}" id="pwa-dock-init">${PWA_OPENING_DOCK_INIT_JS}</script>
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<!-- Retain translucent chrome except for the iOS 27 workaround applied below. -->
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<script nonce="${nonce}" id="pwa-status-bar-init">${PWA_STATUS_BAR_INIT_JS}</script>
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="icon" type="image/png" sizes="256x256" href="/notifications/crate-mark-256.png?v=${PWA_ASSET_VERSION}">
<link rel="apple-touch-icon" sizes="180x180" href="/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}">
<title>Crate</title>
${PWA_STARTUP_ASSETS.filter(name => name !== 'app.js').map(name => `<link nonce="${nonce}" rel="modulepreload" href="/notifications/assets/${name}">`).join('\n')}
<style>
${PWA_STYLES}
</style>
<style id="${PWA_LIGHT_THEME_STYLE_ID}" media="${PWA_LIGHT_SCHEME_MEDIA}">
${PWA_LIGHT_THEME_STYLES}
</style>
	<script nonce="${nonce}" id="pwa-theme-styles">${PWA_THEME_STYLES_JS}</script>
</head>
<body>
	<div id="pwa-update-transition" role="status" aria-live="polite">${updateScreenHtml}</div>
	<div id="app"><div class="pwa-launch-splash" role="status" aria-label="Loading Crate">${createPwaOpeningScreenHtml()}</div></div>
	<script nonce="${nonce}" id="pwa-opening-screen-init">${PWA_OPENING_SCREEN_INIT_JS}</script>
	<script nonce="${nonce}" type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}
