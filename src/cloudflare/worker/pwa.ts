import { PWA_CLIENT_JS } from './pwa-client-bundle.gen';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

export const PWA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0f0f10">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/notifications/manifest.json?v=${PWA_ASSET_VERSION}">
<title>Crate Reminders</title>
<style>
:root{
	--bg:#0f0f10;
	--panel:#161618;
	--panel-2:#1b1b1f;
	--panel-3:#222228;
	--line:rgba(255,255,255,.08);
	--line-soft:rgba(255,255,255,.05);
	--text:#f4f4f5;
	--text-muted:#a1a1aa;
	--text-faint:#71717a;
	--accent:#8b5cf6;
	--accent-strong:#7c3aed;
	--danger:#fb6b6b;
	--success:#22c55e;
	--shadow:0 18px 48px rgba(0,0,0,.4);
	--radius-xl:24px;
	--radius-lg:20px;
	--radius-md:16px;
	--radius-sm:12px;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:radial-gradient(circle at top,#202024 0%,#121214 28%,#0f0f10 68%);color:var(--text);font-family:"SF Pro Display","Inter","Segoe UI",system-ui,sans-serif;min-height:100%;overscroll-behavior:none}
body{min-height:100dvh}
button,input,textarea,select{font:inherit}
button{cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.55}
:focus-visible{outline:2px solid rgba(139,92,246,.72);outline-offset:2px}
#app{min-height:100dvh}
.auth-card{max-width:420px;margin:0 auto;padding:24px 20px;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;gap:14px}
.auth-card h1{margin:0;font-size:34px;line-height:1.06;letter-spacing:-.04em}
.auth-card p{margin:0;color:var(--text-muted);line-height:1.5;font-size:15px}
.app-shell{min-height:100dvh;display:flex;flex-direction:column}
.app-header{padding:14px 16px 10px;position:sticky;top:0;z-index:20;background:linear-gradient(180deg,rgba(15,15,16,.98),rgba(15,15,16,.94),rgba(15,15,16,.78),transparent);backdrop-filter:blur(16px)}
.app-header__top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.header-actions{display:flex;align-items:center;gap:8px}
.header-spacer{display:block;width:36px;height:36px}
.app-header__body h1{margin:0;font-size:32px;line-height:1.05;letter-spacing:-.04em}
.header-meta{margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--text-muted);font-size:14px}
.overdue-pill{display:inline-flex;align-items:center;justify-content:center;padding:8px 12px;border-radius:999px;background:var(--danger);color:#fff;font-weight:700;font-size:14px}
.app-content{flex:1;padding:8px 16px 116px}
.empty-state,.loading-card{margin-top:28px;padding:24px 18px;border-radius:var(--radius-lg);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);text-align:center}
.empty-state h2,.loading-card{font-size:18px}
.empty-state p{margin:10px 0 0;color:var(--text-muted)}
.project-card,.reminder-card,.auth-card,.modal-card,.loading-card,.empty-state{box-shadow:var(--shadow)}
.project-card{display:block;width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius-lg);padding:14px 14px 13px;margin-bottom:10px;text-align:left;color:inherit}
.project-card__row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.project-card__title{font-size:18px;font-weight:700;letter-spacing:-.02em}
.project-card__meta{margin-top:6px;color:var(--text-muted);font-size:14px}
.reminders-stack{display:flex;flex-direction:column;gap:10px}
.reorder-list{display:flex;flex-direction:column;gap:10px}
.reminder-card{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius-lg);overflow:hidden}
.reminder-card.is-completed{opacity:.72}
.reminder-card__main{display:flex;align-items:flex-start;gap:10px;padding:14px}
.checkbox{width:34px;height:34px;flex:0 0 34px;border-radius:999px;border:3px solid rgba(255,255,255,.18);background:transparent;color:white;display:grid;place-items:center;margin-top:2px}
.checkbox.is-checked{background:var(--success);border-color:var(--success)}
.checkbox svg{width:16px;height:16px}
.card-body{flex:1;min-width:0;background:none;border:none;padding:0;color:inherit;text-align:left}
.card-title-row{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.card-title{font-size:18px;font-weight:700;line-height:1.3;letter-spacing:-.02em;word-break:break-word}
.card-description{margin-top:8px;color:var(--text-muted);line-height:1.45;font-size:14px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.card-pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.meta-pill,.tag-pill,.priority-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border-radius:12px;font-size:12px;font-weight:650;border:1px solid rgba(255,255,255,.08)}
.meta-pill{background:rgba(255,255,255,.05);color:var(--text-muted)}
.meta-pill.is-overdue{background:rgba(251,107,107,.12);border-color:rgba(251,107,107,.3);color:#ff8f8f}
.tag-pill{background:rgba(var(--pill-rgb),.10);border-color:rgba(var(--pill-rgb),.28);color:var(--pill-color)}
.priority-pill{background:rgba(251,107,107,.10);border-color:rgba(251,107,107,.18);color:#ff8f8f;text-transform:uppercase;font-size:10px;letter-spacing:.08em}
.meta-pill svg,.tag-pill svg,.card-handle svg,.tab-button__icon svg,.icon-button svg,.fab svg{width:14px;height:14px;display:block}
.card-handle{width:34px;height:34px;flex:0 0 34px;border:none;background:rgba(255,255,255,.04);border-radius:12px;color:var(--text-faint);display:grid;place-items:center;touch-action:none}
.completed-section{margin-top:6px}
.completed-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;color:var(--text-muted);padding:10px 2px 2px;font-size:14px;font-weight:650}
.chevron{font-size:18px;line-height:1;transform:rotate(0deg);transition:transform .16s ease}
.chevron.is-open{transform:rotate(180deg)}
.completed-list{display:flex;flex-direction:column;gap:10px;padding-top:10px}
.date-group{margin-bottom:20px}
.date-group__title{margin:0 0 10px;padding-left:4px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint)}
.bottom-tabs{position:fixed;left:0;right:0;bottom:0;z-index:25;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:rgba(24,24,24,.96);backdrop-filter:blur(24px);border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.tab-button{border:none;background:none;border-radius:14px;padding:10px 6px 8px;display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--text-faint);font-size:11px;font-weight:700;min-height:58px}
.tab-button__icon{width:20px;height:20px}
.tab-button.is-active{background:rgba(139,92,246,.14);color:var(--accent)}
.fab{position:fixed;right:16px;bottom:76px;z-index:24;width:58px;height:58px;border:none;border-radius:999px;background:radial-gradient(circle at 30% 25%,#b084ff 0%,#8b5cf6 42%,#6d28d9 100%);color:white;box-shadow:0 12px 28px rgba(139,92,246,.45)}
.fab svg{width:24px;height:24px;margin:0 auto}
.icon-button,.secondary-button,.primary-button{border:none}
.icon-button{width:36px;height:36px;border-radius:12px;background:rgba(255,255,255,.05);color:var(--text);display:grid;place-items:center}
.icon-button.is-active{background:rgba(139,92,246,.16);color:var(--accent)}
.primary-button,.secondary-button{border-radius:14px;padding:11px 14px;font-weight:700;font-size:14px}
.primary-button{background:var(--accent-strong);color:white}
.secondary-button{background:rgba(255,255,255,.06);color:var(--text)}
.secondary-button.is-danger{background:rgba(251,107,107,.12);color:#ff9a9a}
.modal-backdrop{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.6);backdrop-filter:blur(12px);display:flex;align-items:flex-end;justify-content:center;padding:10px}
.modal-card{width:min(560px,100%);max-height:calc(100dvh - 20px);overflow:auto;background:#17171a;border:1px solid rgba(255,255,255,.08);border-radius:22px;padding:18px 16px calc(18px + env(safe-area-inset-bottom))}
.modal-form{display:flex;flex-direction:column;gap:14px}
.modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.modal-header h2{margin:0;font-size:22px;letter-spacing:-.03em}
.field{display:flex;flex-direction:column;gap:8px}
.field span{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.field input,.field textarea,.field select{width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:#232327;color:var(--text);padding:12px 14px;outline:none}
.field textarea{resize:vertical;min-height:96px}
.field-row{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:10px}
.modal-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
.modal-actions__primary{display:flex;gap:8px}
.toast{position:fixed;left:12px;right:12px;bottom:78px;z-index:45;padding:13px 14px;border-radius:14px;background:#222228;color:white;border:1px solid rgba(255,255,255,.08);box-shadow:var(--shadow);font-size:14px}
.toast.is-success{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.3)}
.toast.is-error{background:rgba(251,107,107,.16);border-color:rgba(251,107,107,.3)}
.toast.is-info{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.3)}
.settings-backdrop{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.35);backdrop-filter:blur(10px)}
.settings-sheet{position:fixed;left:50%;bottom:calc(74px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:31;width:min(420px,calc(100vw - 24px));max-height:calc(100dvh - 110px);overflow:auto;background:var(--panel);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:14px;box-shadow:var(--shadow)}
.settings-sheet__header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.settings-sheet__header h2{margin:0;font-size:18px;letter-spacing:-.02em}
.settings-sheet__header p{margin:6px 0 0;color:var(--text-muted);line-height:1.45;font-size:13px}
.settings-panel{padding:0;border-radius:0;background:none;border:none}
.settings-panel__section+.settings-panel__section{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.06)}
.settings-panel__title{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint);margin-bottom:10px}
.settings-panel__row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.settings-panel__row:last-child{margin-bottom:0}
.settings-panel__row code{max-width:55%;overflow:auto;font-size:12px;color:var(--text-muted);text-align:right}
.settings-panel__hint{margin:8px 0 0;color:var(--text-muted);line-height:1.45;font-size:13px}
.settings-panel__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.placeholder-card{min-height:72px;background:rgba(139,92,246,.08);border:1px dashed rgba(139,92,246,.35)}
.is-dragging{opacity:.98;transform:scale(1.01);box-shadow:0 18px 44px rgba(0,0,0,.45)}
@media (min-width: 760px){
	body{display:flex;justify-content:center}
	#app{width:min(640px,100vw);border-left:1px solid rgba(255,255,255,.06);border-right:1px solid rgba(255,255,255,.06);background:rgba(10,10,11,.45)}
	.app-content{padding-left:18px;padding-right:18px}
	.bottom-tabs{left:50%;transform:translateX(-50%);width:min(640px,100vw)}
	.fab{right:max(calc(50vw - 300px), 20px)}
	.toast{left:50%;right:auto;transform:translateX(-50%);width:min(420px,calc(100vw - 24px))}
}
@media (max-width: 520px){
	.field-row{grid-template-columns:1fr}
}
@media (max-width: 420px){
	.app-header__body h1{font-size:28px}
	.project-card__title{font-size:17px}
	.card-title{font-size:16px}
	.modal-actions{flex-direction:column-reverse;align-items:stretch}
	.modal-actions__primary{display:grid;grid-template-columns:1fr 1fr}
	.settings-panel__row{align-items:flex-start;flex-direction:column}
	.settings-panel__row code{max-width:100%;text-align:left}
}
</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
</body>
</html>`;

export const PWA_APP_JS = PWA_CLIENT_JS;

export const SERVICE_WORKER_JS = `
self.addEventListener('push', function(event) {
	const data = event.data ? event.data.json() : {};
	event.waitUntil(
		self.registration.showNotification(data.title || 'Reminder', {
			body: data.body || '',
			tag: data.tag || 'crate-reminder',
			icon: '/notifications/icon.svg?v=${PWA_ASSET_VERSION}',
			data: {
				project: data.project || '',
				reminderId: data.reminderId || '',
			},
		})
	);
});

self.addEventListener('notificationclick', function(event) {
	event.notification.close();
	var project = (event.notification.data && event.notification.data.project) || '';
	var reminderId = (event.notification.data && event.notification.data.reminderId) || '';
	var params = new URLSearchParams();
	if (project) params.set('project', project);
	if (reminderId) params.set('reminderId', reminderId);
	var url = '/notifications' + (params.toString() ? '?' + params.toString() : '');
	event.waitUntil(clients.openWindow(url));
});

self.addEventListener('pushsubscriptionchange', function() {
	// Re-subscription is handled by the app the next time it opens.
});
`;

export const OPEN_OBSIDIAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening Obsidian...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f10;color:#f4f4f5;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#181818;border-radius:20px;padding:32px;max-width:420px;width:100%;text-align:center;box-shadow:0 18px 48px rgba(0,0,0,.4)}
h1{font-size:1.3rem;margin-bottom:16px;color:#fff}
.btn{display:inline-block;padding:14px 28px;border:none;border-radius:14px;font-size:1rem;font-weight:600;cursor:pointer;background:#7c3aed;color:#fff;text-decoration:none;margin-top:8px}
p{color:#a1a1aa;font-size:.9rem;margin-top:16px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<h1>Opening Obsidian...</h1>
<a id="open-link" href="obsidian://open" class="btn">Open Obsidian</a>
<p>If Obsidian didn't open automatically, tap the button above.</p>
</div>
<script>
var params = new URLSearchParams(location.search);
var project = params.get('project');
var uri = project ? 'obsidian://crate-reminders?project=' + encodeURIComponent(project) : 'obsidian://crate-reminders';
document.getElementById('open-link').href = uri;
window.location.href = uri;
</script>
</body>
</html>`;

export const MANIFEST_JSON = JSON.stringify({
	name: 'Crate Reminders',
	short_name: 'Crate',
	display: 'standalone',
	background_color: '#0f0f10',
	theme_color: '#0f0f10',
	icons: [
		{
			src: `/notifications/icon.svg?v=${PWA_ASSET_VERSION}`,
			sizes: 'any',
			type: 'image/svg+xml',
		},
	],
});

export const ICON_SVG = `<svg id="custom-logo" width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" style="height:100%;width:100%;">
  <defs>
    <radialGradient id="b" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-48 -185 123 -32 179 429.7)">
      <stop stop-color="#fff" stop-opacity=".4"/>
      <stop offset="1" stop-opacity=".1"/>
    </radialGradient>
    <radialGradient id="c" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(41 -310 229 30 341.6 351.3)">
      <stop stop-color="#fff" stop-opacity=".6"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".1"/>
    </radialGradient>
    <radialGradient id="d" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(57 -261 178 39 190.5 296.3)">
      <stop stop-color="#fff" stop-opacity=".8"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".4"/>
    </radialGradient>
    <radialGradient id="e" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-79 -133 153 -90 321.4 464.2)">
      <stop stop-color="#fff" stop-opacity=".3"/>
      <stop offset="1" stop-opacity=".3"/>
    </radialGradient>
    <radialGradient id="f" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-29 136 -92 -20 300.7 149.9)">
      <stop stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".2"/>
    </radialGradient>
    <radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(72 73 -155 153 137.8 225.2)">
      <stop stop-color="#fff" stop-opacity=".2"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".4"/>
    </radialGradient>
    <radialGradient id="h" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(20 118 -251 43 215.1 273.7)">
      <stop stop-color="#fff" stop-opacity=".1"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".3"/>
    </radialGradient>
    <radialGradient id="i" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-162 -85 268 -510 374.4 371.7)">
      <stop stop-color="#fff" stop-opacity=".2"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".2"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".3"/>
    </radialGradient>
    <filter id="a" x="80.1" y="37" width="351.1" height="443.2" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="6.5" result="effect1_foregroundBlur_744_9191"/>
    </filter>
  </defs>
  <rect id="logo-bg" fill="#262626" width="512" height="512" rx="100"/>
  <g filter="url(#a)">
    <path d="M359.2 437.5c-2.6 19-21.3 33.9-40 28.7-26.5-7.2-57.2-18.6-84.8-20.7l-42.4-3.2a28 28 0 0 1-18-8.3l-73-74.8a27.7 27.7 0 0 1-5.4-30.7s45-98.6 46.8-103.7c1.6-5.1 7.8-49.9 11.4-73.9a28 28 0 0 1 9-16.5L249 57.2a28 28 0 0 1 40.6 3.4l72.6 91.6a29.5 29.5 0 0 1 6.2 18.3c0 17.3 1.5 53 11.2 76a301.3 301.3 0 0 0 35.6 58.2 14 14 0 0 1 1 15.6c-6.3 10.7-18.9 31.3-36.6 57.6a142.2 142.2 0 0 0-20.5 59.6Z" fill="#000" fill-opacity=".3"/>
  </g>
  <path id="arrow" d="M359.9 434.3c-2.6 19.1-21.3 34-40 28.9-26.4-7.3-57-18.7-84.7-20.8l-42.3-3.2a27.9 27.9 0 0 1-18-8.4l-73-75a27.9 27.9 0 0 1-5.4-31s45.1-99 46.8-104.2c1.7-5.1 7.8-50 11.4-74.2a28 28 0 0 1 9-16.6l86.2-77.5a28 28 0 0 1 40.6 3.5l72.5 92a29.7 29.7 0 0 1 6.2 18.3c0 17.4 1.5 53.2 11.1 76.3a303 303 0 0 0 35.6 58.5 14 14 0 0 1 1.1 15.7c-6.4 10.8-18.9 31.4-36.7 57.9a143.3 143.3 0 0 0-20.4 59.8Z" fill="#6C31E3"/>
  <path d="M182.7 436.4c33.9-68.7 33-118 18.5-153-13.2-32.4-37.9-52.8-57.3-65.5-.4 1.9-1 3.7-1.8 5.4L96.5 324.8a27.9 27.9 0 0 0 5.5 31l72.9 75c2.3 2.3 5 4.2 7.8 5.6Z" fill="url(#b)"/>
  <path d="M274.9 297c9.1.9 18 2.9 26.8 6.1 27.8 10.4 53.1 33.8 74 78.9 1.5-2.6 3-5.1 4.6-7.5a1222 1222 0 0 0 36.7-57.9 14 14 0 0 0-1-15.7 303 303 0 0 1-35.7-58.5c-9.6-23-11-58.9-11.1-76.3 0-6.6-2.1-13.1-6.2-18.3l-72.5-92-1.2-1.5c5.3 17.5 5 31.5 1.7 44.2-3 11.8-8.6 22.5-14.5 33.8-2 3.8-4 7.7-5.9 11.7a140 140 0 0 0-15.8 58c-1 24.2 3.9 54.5 20 95Z" fill="url(#c)"/>
  <path d="M274.8 297c-16.1-40.5-21-70.8-20-95 1-24 8-42 15.8-58l6-11.7c5.8-11.3 11.3-22 14.4-33.8a78.5 78.5 0 0 0-1.7-44.2 28 28 0 0 0-39.4-2l-86.2 77.5a28 28 0 0 0-9 16.6L144.2 216c0 .7-.2 1.3-.3 2 19.4 12.6 44 33 57.3 65.3 2.6 6.4 4.8 13.1 6.4 20.4a200 200 0 0 1 67.2-6.8Z" fill="url(#d)"/>
  <path d="M320 463.2c18.6 5.1 37.3-9.8 39.9-29a153 153 0 0 1 15.9-52.2c-21-45.1-46.3-68.5-74-78.9-29.5-11-61.6-7.3-94.2.6 7.3 33.1 3 76.4-24.8 132.7 3.1 1.6 6.6 2.5 10.1 2.8l43.9 3.3c23.8 1.7 59.3 14 83.2 20.7Z" fill="url(#e)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M255 200.5c-1.1 24 1.9 51.4 18 91.8l-5-.5c-14.5-42.1-17.7-63.7-16.6-88 1-24.3 8.9-43 16.7-59 2-4 6.6-11.5 8.6-15.3 5.8-11.3 9.7-17.2 13-27.5 4.8-14.4 3.8-21.2 3.2-28 3.7 24.5-10.4 45.8-21 67.5a145 145 0 0 0-17 59Z" fill="url(#f)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M206 285.1c2 4.4 3.7 8 4.9 13.5l-4.3 1c-1.7-6.4-3-11-5.5-16.5-14.6-34.3-38-52-57-65 23 12.4 46.7 31.9 61.9 67Z" fill="url(#g)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M211.1 303c8 37.5-1 85.2-27.5 131.6 22.2-46 33-90.1 24-131l3.5-.7Z" fill="url(#h)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M302.7 299.5c43.5 16.3 60.3 52 72.8 81.9-15.5-31.2-37-65.7-74.4-78.5-28.4-9.8-52.4-8.6-93.5.7l-.9-4c43.6-10 66.4-11.2 96 0Z" fill="url(#i)"/>
</svg>`;
