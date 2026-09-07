export const PWA_UPDATE_TRANSITION_KEY = 'crate-pwa-update-transition';
export const PWA_UPDATE_TRANSITION_MAX_AGE_MS = 60_000;

/** Cover only the reload; downloading the update leaves the current app visible. */
export async function preparePwaUpdateTransition(): Promise<void> {
	document.documentElement.dataset.pwaUpdating = 'prepare';
	document.getElementById('app')?.setAttribute('inert', '');
	// Let the curtain paint fully before replacing the document. Match the CSS
	// fade duration, including a frame for the initial style change.
	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	await new Promise(resolve => window.setTimeout(resolve, reduceMotion ? 32 : 220));
	try {
		sessionStorage.setItem(PWA_UPDATE_TRANSITION_KEY, String(Date.now()));
	} catch {
		// Updating still works when session storage is unavailable.
	}
}

export function finishPwaUpdateTransition(): void {
	delete document.documentElement.dataset.pwaUpdating;
	document.getElementById('app')?.removeAttribute('inert');
	try {
		sessionStorage.removeItem(PWA_UPDATE_TRANSITION_KEY);
	} catch {
		// The transition is cosmetic and must never prevent recovery.
	}
}
