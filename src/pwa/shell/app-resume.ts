/** Returning to the foreground within this gap may reuse the last check or refresh;
 * reconnecting never does. */
export const FOREGROUND_REFRESH_GAP_MS = 30_000;

export type AppResumeReason = 'online' | 'foreground';

/** Calls `listener` when the browser reconnects (`online`) or the app returns to the
 * foreground (`pageshow`, or the document becoming visible). One resume can fire both
 * foreground events, so callers throttle or coalesce their work. Returns a cleanup. */
export function onAppResume(listener: (reason: AppResumeReason) => void): () => void {
	const online = () => listener('online');
	const foreground = () => listener('foreground');
	const visibility = () => { if (document.visibilityState === 'visible') listener('foreground'); };
	window.addEventListener('online', online);
	window.addEventListener('pageshow', foreground);
	document.addEventListener('visibilitychange', visibility);
	return () => {
		window.removeEventListener('online', online);
		window.removeEventListener('pageshow', foreground);
		document.removeEventListener('visibilitychange', visibility);
	};
}
