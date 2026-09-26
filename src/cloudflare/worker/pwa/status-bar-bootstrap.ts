// Run in the head before first paint, including the Safari page used to install
// the app. Keep the cached shell identical across platforms.
// Safari freezes the OS token; Home Screen UAs may instead expose the real OS
// without a Version token. Unknown versions deliberately retain the old mode.
export const PWA_STATUS_BAR_INIT_JS = String.raw`
(() => {
	const ua = navigator.userAgent;
	const appleMobile = /iPhone|iPad|iPod/.test(ua)
		|| (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
	if (!appleMobile || !/AppleWebKit\//.test(ua)) return;
	const os = Number(/\bOS (\d+)[_\.]/.exec(ua)?.[1]);
	const safari = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS)\//.test(ua)
		? 0 : Number(/\bVersion\/(\d+)[\.\s]/.exec(ua)?.[1]);
	if ((os >= 26 ? os : safari) !== 27) return;
	const meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
	if (!meta) return;
	meta.setAttribute('content', 'default');
	if (navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches) {
		document.documentElement.dataset.pwaIos27Standalone = 'true';
	}
})();`;
