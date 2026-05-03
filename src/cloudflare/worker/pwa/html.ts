import { PWA_ASSET_VERSION } from '../pwa-version.gen';
import { manifestHrefForUrl, PWA_CHROME_COLOR } from './pwa-params';
import { PWA_STYLES } from './styles';

export function createPwaHtml(requestUrl?: string): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, height=device-height, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="application-name" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="${PWA_CHROME_COLOR}">
<meta name="format-detection" content="telephone=no,date=no,email=no,address=no">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="apple-touch-icon" href="/notifications/icon.svg?v=${PWA_ASSET_VERSION}">
<title>Crate Reminders</title>
<style>
${PWA_STYLES}
</style>
</head>
	<body>
	<div id="app"></div>
	<script>
	(function() {
		var blockZoom = function(event) {
			event.preventDefault();
		};
		document.addEventListener('gesturestart', blockZoom, { passive: false });
		document.addEventListener('gesturechange', blockZoom, { passive: false });
		document.addEventListener('gestureend', blockZoom, { passive: false });
	})();
	</script>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}

export const PWA_HTML = createPwaHtml();
