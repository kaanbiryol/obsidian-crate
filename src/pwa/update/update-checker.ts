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

export async function fetchPwaAssetVersion(): Promise<string | null> {
	const response = await fetch(`/notifications/version.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
	if (!response.ok) return null;
	const result = await response.json() as { assetVersion?: string };
	return typeof result.assetVersion === 'string' && result.assetVersion.trim() ? result.assetVersion : null;
}
