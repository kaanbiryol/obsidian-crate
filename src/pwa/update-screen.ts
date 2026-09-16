import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';

// Build-owned markup shared by React's launch splash and the pre-JS reload
// curtain. Keep this free of user content so both screens paint identically.
export const PWA_UPDATE_SCREEN_HTML = `<div class="pwa-update-screen">
	<div class="pwa-update-screen__icon" aria-hidden="true">
		<img src="/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}" width="76" height="76" alt="">
	</div>
	<div class="pwa-update-screen__title">Updating Crate</div>
	<div class="pwa-update-screen__detail">Getting the latest version ready.</div>
	<div class="pwa-update-screen__activity" aria-hidden="true"><span></span></div>
</div>`;
