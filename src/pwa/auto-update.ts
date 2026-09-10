import { preparePwaUpdate } from './apply-update';

const AUTO_UPDATE_VERSION_KEY = 'crate-pwa-auto-update-version';
const IDLE_MS = 2_000;

/** Foreground-only scheduling works when iOS suspends timers in Home Screen apps. */
export function startAutoPwaUpdate(
	version: string,
	canApply: () => boolean,
	apply: (version: string, isSafe: () => boolean, beforeNavigation: () => boolean) => Promise<boolean>,
): () => void {
	let stopped = false;
	let running = false;
	let failed = false;
	let ready = false;
	let pointerDown = false;
	let lastActivity = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const alreadyReloaded = () => {
		try { return sessionStorage.getItem(AUTO_UPDATE_VERSION_KEY) === version; }
		catch { return true; } // Keep manual updates when a reload cannot be guarded.
	};
	const isSafe = () => !stopped && !alreadyReloaded() && canApply()
		&& navigator.onLine && document.visibilityState === 'visible' && !pointerDown
		&& Date.now() - lastActivity >= IDLE_MS
		&& !document.querySelector('[role="dialog"], [role="alertdialog"]');
	const beforeNavigation = () => {
		try { sessionStorage.setItem(AUTO_UPDATE_VERSION_KEY, version); return true; }
		catch { return false; }
	};
	const schedule = () => {
		clearTimeout(timer);
		if (!stopped && !failed && !alreadyReloaded()) timer = setTimeout(() => { void run(); }, IDLE_MS);
	};
	const run = async () => {
		if (stopped || running || failed || alreadyReloaded()) return;
		if (!navigator.onLine || document.visibilityState !== 'visible') return;
		running = true;
		try {
			if (!ready) {
				await preparePwaUpdate(version);
				ready = true;
			}
			if (isSafe() && await apply(version, isSafe, beforeNavigation)) return;
		} catch {
			// No error toast or retry loop for an opportunistic update.
			failed = true;
		} finally {
			running = false;
			schedule();
		}
	};
	const activity = () => { lastActivity = Date.now(); schedule(); };
	const down = () => { pointerDown = true; activity(); };
	const up = () => { pointerDown = false; activity(); };
	const resume = () => {
		lastActivity = Date.now();
		pointerDown = false;
		if (document.visibilityState !== 'visible' || !navigator.onLine) {
			clearTimeout(timer);
			return;
		}
		failed = false;
		schedule();
	};
	window.addEventListener('pageshow', resume);
	window.addEventListener('online', resume);
	document.addEventListener('visibilitychange', resume);
	document.addEventListener('pointerdown', down, true);
	document.addEventListener('pointerup', up, true);
	document.addEventListener('pointercancel', up, true);
	document.addEventListener('keydown', activity, true);
	document.addEventListener('scroll', activity, true);
	// Start downloading immediately; activation still requires an idle foreground.
	void run();
	return () => {
		stopped = true;
		clearTimeout(timer);
		window.removeEventListener('pageshow', resume);
		window.removeEventListener('online', resume);
		document.removeEventListener('visibilitychange', resume);
		document.removeEventListener('pointerdown', down, true);
		document.removeEventListener('pointerup', up, true);
		document.removeEventListener('pointercancel', up, true);
		document.removeEventListener('keydown', activity, true);
		document.removeEventListener('scroll', activity, true);
	};
}
