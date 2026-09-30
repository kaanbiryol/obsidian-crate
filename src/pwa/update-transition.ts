export const PWA_UPDATE_TRANSITION_KEY = 'crate-pwa-update-transition';
export const PWA_UPDATE_TRANSITION_POSITION_KEY = 'crate-pwa-update-position';
export const PWA_UPDATE_TRANSITION_MAX_AGE_MS = 60_000;
export const PWA_UPDATE_OPENING_PROGRESS = 0.9;
// Recover if the browser suspends or cancels transition completion.
const UPDATE_REVEAL_FALLBACK_MS = 1000;
let revealTimer: number | undefined;
let revealGeneration = 0;

function stopPendingReveal(): void {
	window.clearTimeout(revealTimer);
	revealGeneration++;
}

/** Stage milestones, not download percentages. Never advance on a timer. */
export function advancePwaUpdateProgress(stage: 'checking' | 'downloading' | 'activating' | 'opening' | 'ready'): void {
	const milestones = { checking: 0.12, downloading: 0.32, activating: 0.68, opening: PWA_UPDATE_OPENING_PROGRESS, ready: 1 };
	const style = document.documentElement.style;
	const current = stage === 'checking' ? 0 : Number(style.getPropertyValue('--pwa-update-progress')) || 0;
	style.setProperty('--pwa-update-progress', String(Math.max(current, milestones[stage])));
}

/** Show immediately for a requested update, without creating a reload marker. */
export function showPwaUpdateTransition(): void {
	stopPendingReveal();
	if (document.documentElement.dataset.pwaUpdating === 'prepare') return;
	// Mobile browser chrome can resize the viewport during reload. Keep the
	// message at the same height while the curtain continues to cover the screen.
	const overlay = document.getElementById('pwa-update-transition');
	const launchScreen = document.querySelector<HTMLElement>('.pwa-launch-splash.is-updating .pwa-update-screen');
	const launchRect = launchScreen?.getBoundingClientRect();
	const labelTop = launchRect ? launchRect.top + launchRect.height / 2
		: (overlay?.getBoundingClientRect().height ?? window.innerHeight) / 2;
	// Two translucent copies can ghost or flash during the launch handoff.
	// Replace the already-visible screen at full opacity and the same position.
	if (overlay) overlay.dataset.launchHandoff = String(Boolean(launchScreen));
	const activity = overlay?.querySelector<HTMLElement>('.pwa-update-screen__activity span');
	const launchActivity = document.querySelector('.pwa-launch-splash.is-updating .pwa-update-screen__activity span');
	// A fresh button press starts a new attempt. Launch updates already share
	// the root progress value with the curtain, so their handoff cannot rewind.
	activity?.classList.add('is-resetting');
	if (launchActivity && activity) activity.style.transform = getComputedStyle(launchActivity).transform;
	else advancePwaUpdateProgress('checking');
	// Resolve the visible width while hidden. Safari can defer transitions on
	// the curtain, so copy the launch bar's painted width as well as its target.
	void activity?.offsetWidth;
	activity?.classList.remove('is-resetting');
	document.documentElement.style.setProperty('--pwa-update-label-top', `${labelTop}px`);
	document.documentElement.dataset.pwaUpdating = 'prepare';
	activity?.style.removeProperty('transform');
	document.getElementById('app')?.setAttribute('inert', '');
}

/** Keep the same curtain and progress through activation and navigation. */
export async function preparePwaUpdateTransition(): Promise<void> {
	showPwaUpdateTransition();
	advancePwaUpdateProgress('opening');
	// Let the curtain paint fully before replacing the document. Match the CSS
	// fade duration, including a frame for the initial style change.
	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	await new Promise(resolve => window.setTimeout(resolve, reduceMotion ? 32 : 220));
	try {
		const labelTop = parseFloat(document.documentElement.style.getPropertyValue('--pwa-update-label-top'));
		sessionStorage.setItem(PWA_UPDATE_TRANSITION_POSITION_KEY, String(labelTop));
		sessionStorage.setItem(PWA_UPDATE_TRANSITION_KEY, String(Date.now()));
	} catch {
		// Updating still works when session storage is unavailable.
	}
}

export function finishPwaUpdateTransition({ fade = false }: { fade?: boolean } = {}): void {
	stopPendingReveal();
	const overlay = document.getElementById('pwa-update-transition');
	if (fade && document.documentElement.dataset.pwaUpdating === 'restore'
		&& overlay
		&& !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		// The home screen is already rendered and settled beneath the curtain.
		// Keep it inert until the reveal finishes so taps cannot pass through.
		document.documentElement.dataset.pwaUpdating = 'revealing';
		// A timer started at the style change can expire before the browser's
		// first painted transition frame. Wait for the actual opacity animation.
		const animation = overlay.getAnimations().find(animation =>
			(animation as CSSTransition).transitionProperty === 'opacity');
		if (!animation) { clearPwaUpdateTransition(); return; }
		const generation = revealGeneration;
		const complete = () => { if (generation === revealGeneration) clearPwaUpdateTransition(); };
		revealTimer = window.setTimeout(complete, UPDATE_REVEAL_FALLBACK_MS);
		void animation.finished.then(complete, complete);
		return;
	}
	clearPwaUpdateTransition();
}

function clearPwaUpdateTransition(): void {
	stopPendingReveal();
	// Retain the label position through the CSS fade; the next update resets it.
	delete document.documentElement.dataset.pwaUpdating;
	document.getElementById('app')?.removeAttribute('inert');
	try {
		sessionStorage.removeItem(PWA_UPDATE_TRANSITION_KEY);
		sessionStorage.removeItem(PWA_UPDATE_TRANSITION_POSITION_KEY);
	} catch {
		// The transition is cosmetic and must never prevent recovery.
	}
}
