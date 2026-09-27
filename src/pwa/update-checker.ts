export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

/** One foreground check at a time; lifecycle events also recover from suspended timers. */
export function startUpdateChecks(check: () => Promise<void>): () => void {
	let disposed = false;
	let checking = false;
	const run = async () => {
		if (disposed || checking || !navigator.onLine || document.visibilityState !== 'visible') return;
		checking = true;
		try { await check(); } catch { /* Opportunistic checks never interrupt app use. */ }
		finally { checking = false; }
	};
	const resume = () => { void run(); };
	window.addEventListener('pageshow', resume);
	window.addEventListener('online', resume);
	document.addEventListener('visibilitychange', resume);
	const timer = window.setInterval(resume, UPDATE_CHECK_INTERVAL_MS);
	resume();
	return () => {
		disposed = true;
		window.clearInterval(timer);
		window.removeEventListener('pageshow', resume);
		window.removeEventListener('online', resume);
		document.removeEventListener('visibilitychange', resume);
	};
}
