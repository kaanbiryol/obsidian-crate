const STORAGE_KEY = 'crate-initial-enrollment';
const claimButton = document.getElementById('claim-button');
const openButton = document.getElementById('open-button');
const copyButton = document.getElementById('copy-button');
const setupLink = document.getElementById('setup-link');
const stateTitle = document.getElementById('state-title');
const stateText = document.getElementById('state-text');
const claimActions = document.getElementById('claim-actions');
const readyActions = document.getElementById('ready-actions');
const securityNote = document.getElementById('security-note');

function setVisible(element, visible) {
	element?.classList.toggle('hidden', !visible);
}

function setState(title, message) {
	if (stateTitle) stateTitle.textContent = title;
	if (stateText) stateText.textContent = message;
}

function bytesToBase64Url(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

async function sha256Hex(value) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function requestJson(path, options) {
	const response = await fetch(path, {
		cache: 'no-store',
		headers: { 'Content-Type': 'application/json' },
		...options,
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`);
	}
	return body;
}

function loadEnrollment() {
	try {
		const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
		if (
			value
			&& typeof value.token === 'string'
			&& typeof value.expiresAt === 'string'
			&& Date.parse(value.expiresAt) > Date.now()
		) {
			return value;
		}
	} catch {
		// Ignore malformed local setup state.
	}
	localStorage.removeItem(STORAGE_KEY);
	return null;
}

function showUnclaimed() {
	setState('Claim your Crate server', 'Claim this new deployment, then connect it to Obsidian.');
	setVisible(claimActions, true);
	setVisible(readyActions, false);
	setVisible(securityNote, true);
}

function showReady(enrollment) {
	const params = new URLSearchParams({
		workerUrl: location.origin,
		enrollmentToken: enrollment.token,
		expiresAt: enrollment.expiresAt,
	});
	const link = `obsidian://crate-setup?${params.toString()}`;
	if (openButton) openButton.href = link;
	if (setupLink) setupLink.textContent = link;
	setState('Ready to connect', 'This one-time setup link expires in 10 minutes.');
	setVisible(claimActions, false);
	setVisible(readyActions, true);
	setVisible(securityNote, true);
}

function showClaimed() {
	setState('Crate is running', 'This server is already claimed. Use Crate in Obsidian to add another device.');
	setVisible(claimActions, false);
	setVisible(readyActions, false);
	setVisible(securityNote, false);
	localStorage.removeItem(STORAGE_KEY);
}

async function refresh() {
	try {
		const status = await requestJson('/setup/status');
		if (!status.claimed) {
			showUnclaimed();
			return;
		}

		const enrollment = loadEnrollment();
		if (
			status.enrollmentAvailable
			&& enrollment
			&& typeof status.enrollmentTokenHash === 'string'
			&& await sha256Hex(enrollment.token) === status.enrollmentTokenHash
		) {
			showReady(enrollment);
			return;
		}
		showClaimed();
	} catch (error) {
		setState('Setup unavailable', error instanceof Error ? error.message : 'Could not load setup status.');
	}
}

claimButton?.addEventListener('click', async () => {
	claimButton.disabled = true;
	setState('Claiming server…', 'Keep this page open while Crate creates your one-time setup link.');
	try {
		const token = createToken();
		const tokenHash = await sha256Hex(token);
		const enrollment = {
			token,
			expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(enrollment));
		const result = await requestJson('/setup/claim', {
			method: 'POST',
			body: JSON.stringify({ enrollmentTokenHash: tokenHash }),
		});
		enrollment.expiresAt = result.expiresAt;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(enrollment));
		showReady(enrollment);
	} catch (error) {
		await refresh();
		if (!claimActions?.classList.contains('hidden')) {
			setState('Could not claim server', error instanceof Error ? error.message : 'Claim failed.');
			claimButton.disabled = false;
		}
	}
});

copyButton?.addEventListener('click', async () => {
	const link = setupLink?.textContent || '';
	if (!link) return;
	try {
		await navigator.clipboard.writeText(link);
		copyButton.textContent = 'Copied';
	} catch {
		copyButton.textContent = 'Copy failed';
	}
});

void refresh();
