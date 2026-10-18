/** One check at a time, on launch, foreground and reconnect; never on a timer. */
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
	resume();
	return () => {
		disposed = true;
		window.removeEventListener('pageshow', resume);
		window.removeEventListener('online', resume);
		document.removeEventListener('visibilitychange', resume);
	};
}
