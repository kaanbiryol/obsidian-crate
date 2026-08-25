(() => {
	'use strict';

	const source = window.__crateOAuthCallback;
	delete window.__crateOAuthCallback;
	const status = document.querySelector('[data-callback-status]');
	const fallback = document.querySelector('[data-callback-fallback]');
	if (
		typeof source !== 'string'
		|| !(status instanceof HTMLElement)
		|| !(fallback instanceof HTMLAnchorElement)
	) {
		return;
	}

	const incoming = new URLSearchParams(source);
	const state = incoming.get('state');
	const code = incoming.get('code');
	const error = incoming.get('error');
	if (!state || (!code && !error)) {
		return;
	}

	const outgoing = new URLSearchParams({ state });
	if (code) outgoing.set('code', code);
	if (error) outgoing.set('error', error);
	const obsidianUrl = `obsidian://crate-cloudflare-oauth?${outgoing.toString()}`;
	fallback.href = obsidianUrl;
	fallback.hidden = false;
	// eslint-disable-next-line obsidianmd/ui/sentence-case -- Obsidian and Crate are product names.
	status.textContent = 'Opening Obsidian to continue with Crate…';
	window.location.replace(obsidianUrl);
})();
