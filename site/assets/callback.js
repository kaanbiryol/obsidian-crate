(() => {
	'use strict';

	const source = window.__crateOAuthCallback;
	delete window.__crateOAuthCallback;
	const status = document.querySelector('[data-callback-status]');
	const fallback = document.querySelector('[data-callback-fallback]');
	if (typeof source !== 'string' || !(status instanceof HTMLElement) || !(fallback instanceof HTMLAnchorElement)) {
		return;
	}

	const incoming = new URLSearchParams(source);
	const state = incoming.get('state');
	const code = incoming.get('code');
	const error = incoming.get('error');
	if (!state || (!code && !error)) {
		status.textContent = 'The callback is incomplete; return to settings and start deployment again.';
		return;
	}

	const outgoing = new URLSearchParams({ state });
	if (code) outgoing.set('code', code);
	if (error) outgoing.set('error', error);
	const obsidianUrl = `obsidian://crate-cloudflare-oauth?${outgoing.toString()}`;
	fallback.href = obsidianUrl;
	fallback.hidden = false;
	status.textContent = 'Authorization complete. Opening Obsidian…';
	window.location.replace(obsidianUrl);
})();
