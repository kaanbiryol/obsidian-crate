import { preparePwaUpdate } from './apply-update';

const AUTO_UPDATE_VERSION_KEY = 'crate-pwa-auto-update-version';

/** Only run while the launch splash is held; visible content never auto-reloads. */
export function startAutoPwaUpdate(
	version: string,
	canApply: () => boolean,
	apply: (version: string, isSafe: () => boolean, beforeNavigation: () => boolean) => Promise<boolean>,
	onDeferred: () => void,
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const alreadyReloaded = () => {
		try { return sessionStorage.getItem(AUTO_UPDATE_VERSION_KEY) === version; }
		catch { return true; } // Keep manual updates when a reload cannot be guarded.
	};
	const isSafe = () => !stopped && !alreadyReloaded() && canApply()
		&& navigator.onLine && document.visibilityState === 'visible'
		&& !document.querySelector('[role="dialog"], [role="alertdialog"]');
	const beforeNavigation = () => {
		try { sessionStorage.setItem(AUTO_UPDATE_VERSION_KEY, version); return true; }
		catch { return false; }
	};
	const run = async () => {
		if (stopped) return;
		if (alreadyReloaded() || !navigator.onLine || document.visibilityState !== 'visible') {
			onDeferred();
			return;
		}
		try {
			if (!isSafe()) {
				// Hydration may still be finishing behind the bounded launch splash.
				timer = setTimeout(() => { void run(); }, 50);
				return;
			}
			if (!await apply(version, isSafe, beforeNavigation) && !stopped) onDeferred();
		} catch {
			if (!stopped) onDeferred();
		}
	};
	// Download ahead without activating a worker underneath an unfinished editor.
	void preparePwaUpdate(version).then(run).catch(() => {
		if (!stopped) onDeferred();
	});
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
