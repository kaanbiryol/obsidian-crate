export const PWA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#7c3aed">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/notifications/manifest.json">
<title>Crate Notifications</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f23;color:#e0e0e0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.card{background:#1a1a2e;border-radius:16px;padding:32px;max-width:400px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.3)}
h1{font-size:1.5rem;margin-bottom:8px;color:#fff}
.subtitle{color:#888;margin-bottom:24px;font-size:.9rem}
.btn{display:inline-block;padding:14px 28px;border:none;border-radius:12px;font-size:1rem;font-weight:600;cursor:pointer;transition:all .2s}
.btn-primary{background:#7c3aed;color:#fff}
.btn-primary:hover{background:#6d28d9}
.btn-primary:disabled{background:#444;cursor:not-allowed}
.status{margin-top:16px;padding:12px;border-radius:8px;font-size:.9rem}
.status-ok{background:#065f46;color:#6ee7b7}
.status-err{background:#7f1d1d;color:#fca5a5}
.status-info{background:#1e3a5f;color:#93c5fd}
.ios-hint{margin-top:20px;padding:16px;background:#2a2a3e;border-radius:12px;font-size:.85rem;color:#aaa;line-height:1.5}
.ios-hint strong{color:#e0e0e0}
#app{width:100%}
.hidden{display:none}
</style>
</head>
<body>
<div class="card">
<h1>Crate Notifications</h1>
<p class="subtitle">Receive push notifications for your reminders</p>
<div id="app">
<div id="unsupported" class="hidden">
<div class="status status-err">Push notifications are not supported in this browser.</div>
</div>
<div id="ios-standalone" class="hidden">
<div class="ios-hint">
<strong>Almost there!</strong><br>
To receive notifications on iOS, tap <strong>Share</strong> (box with arrow) then <strong>Add to Home Screen</strong>. Open from there to complete setup.
</div>
</div>
<div id="subscribe-section" class="hidden">
<button id="subscribe-btn" class="btn btn-primary">Enable Notifications</button>
<div id="status" class="hidden"></div>
</div>
<div id="subscribed-section" class="hidden">
<div class="status status-ok">Notifications enabled</div>
</div>
</div>
</div>
<script>
(async function() {
	const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
	const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

	// Save auth token from URL param or hash. On iOS the PWA has separate storage
	// from Safari, so we use a query param (preserved when adding to home screen).
	const params = new URLSearchParams(location.search);
	const tokenFromQuery = params.get('token');
	const tokenFromHash = location.hash.slice(1);
	const tokenFromUrl = tokenFromQuery || tokenFromHash;
	if (tokenFromUrl) {
		localStorage.setItem('crate-push-token', tokenFromUrl);
		const shouldPreserveQueryForIOSInstall = Boolean(tokenFromQuery && isIOS && !isStandalone);
		if (!shouldPreserveQueryForIOSInstall) {
			history.replaceState(null, '', location.pathname);
		}
	}
	const token = localStorage.getItem('crate-push-token');

	// iOS only exposes PushManager inside a standalone PWA - check this first
	if (isIOS && !isStandalone) {
		show('ios-standalone');
		return;
	}

	if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
		show('unsupported');
		return;
	}

	// Register service worker
	const reg = await navigator.serviceWorker.register('/notifications/sw.js');
	const sub = await reg.pushManager.getSubscription();

	if (sub) {
		show('subscribed-section');
		return;
	}

	show('subscribe-section');
	const btn = document.getElementById('subscribe-btn');
	const statusEl = document.getElementById('status');

	btn.addEventListener('click', async () => {
		btn.disabled = true;
		btn.textContent = 'Setting up...';
		try {
			const keyResp = await fetch('/notifications/vapid-public-key');
			const { publicKey } = await keyResp.json();
			const applicationServerKey = urlBase64ToUint8Array(publicKey);

			const subscription = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey,
			});

			const subJson = subscription.toJSON();
			const resp = await fetch('/notifications/subscribe', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { 'Authorization': 'Bearer ' + token } : {}),
				},
				body: JSON.stringify({
					endpoint: subJson.endpoint,
					keys: subJson.keys,
					deviceName: detectDeviceName(),
				}),
			});

			if (!resp.ok) {
				const body = await resp.text().catch(() => '');
				throw new Error(resp.status + ': ' + (body || resp.statusText));
			}

			show('subscribed-section');
			hide('subscribe-section');
		} catch (err) {
			showStatus(err.message || 'Failed to subscribe', true);
			btn.disabled = false;
			btn.textContent = 'Enable Notifications';
		}
	});

	function show(id) { document.getElementById(id).classList.remove('hidden'); }
	function hide(id) { document.getElementById(id).classList.add('hidden'); }
	function showStatus(msg, isError) {
		statusEl.textContent = msg;
		statusEl.className = 'status ' + (isError ? 'status-err' : 'status-ok');
		statusEl.classList.remove('hidden');
	}
	function detectDeviceName() {
		const ua = navigator.userAgent;
		if (/iPhone/.test(ua)) return 'iPhone';
		if (/iPad/.test(ua)) return 'iPad';
		if (/Android/.test(ua)) return 'Android';
		if (/Mac/.test(ua)) return 'Mac';
		if (/Windows/.test(ua)) return 'Windows';
		return 'Unknown';
	}
	function urlBase64ToUint8Array(base64String) {
		const padding = '='.repeat((4 - base64String.length % 4) % 4);
		const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
		const rawData = atob(base64);
		const outputArray = new Uint8Array(rawData.length);
		for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
		return outputArray;
	}
})();
</script>
</body>
</html>`;

export const SERVICE_WORKER_JS = `
self.addEventListener('push', function(event) {
	const data = event.data ? event.data.json() : {};
	event.waitUntil(
		self.registration.showNotification(data.title || 'Reminder', {
			body: data.body || '',
			tag: data.tag || 'crate-reminder',
			icon: '/notifications/icon.svg',
			data: { project: data.project || '' },
		})
	);
});

self.addEventListener('notificationclick', function(event) {
	event.notification.close();
	var project = (event.notification.data && event.notification.data.project) || '';
	var url = '/notifications/open-obsidian' + (project ? '?project=' + encodeURIComponent(project) : '');
	event.waitUntil(clients.openWindow(url));
});

self.addEventListener('pushsubscriptionchange', function(event) {
	const token = self.registration.scope.includes('#')
		? null
		: null; // re-subscription handled by app on next visit
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
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f23;color:#e0e0e0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1a1a2e;border-radius:16px;padding:32px;max-width:400px;width:100%;text-align:center}
h1{font-size:1.3rem;margin-bottom:16px;color:#fff}
.btn{display:inline-block;padding:14px 28px;border:none;border-radius:12px;font-size:1rem;font-weight:600;cursor:pointer;background:#7c3aed;color:#fff;text-decoration:none;margin-top:8px}
p{color:#888;font-size:.85rem;margin-top:16px}
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

// No start_url - iOS uses the page URL (with ?token=) when adding to home screen
export const MANIFEST_JSON = JSON.stringify({
	name: 'Crate Notifications',
	short_name: 'Crate',
	display: 'standalone',
	background_color: '#0f0f23',
	theme_color: '#7c3aed',
	icons: [
		{
			src: '/notifications/icon.svg',
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
