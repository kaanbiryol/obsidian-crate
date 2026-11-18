import { FOREGROUND_REFRESH_GAP_MS, onAppResume, type AppResumeReason } from '../shell/app-resume';

/** One check at a time, on launch, foreground and reconnect; never on a timer. */
export function startUpdateChecks(check: () => Promise<void>): () => void {
	let disposed = false;
	let checking = false;
	let lastCheck = -Infinity;
	const run = async (reason?: AppResumeReason) => {
		if (disposed || checking || !navigator.onLine || document.visibilityState !== 'visible') return;
		// pageshow and visibilitychange both fire on one resume. Reconnection always checks.
		if (reason !== 'online' && Date.now() - lastCheck < FOREGROUND_REFRESH_GAP_MS) return;
		lastCheck = Date.now();
		checking = true;
		try { await check(); } catch { lastCheck = -Infinity; /* Opportunistic checks never interrupt app use. */ }
		finally { checking = false; }
	};
	const stop = onAppResume(reason => { void run(reason); });
	void run();
	return () => {
		disposed = true;
		stop();
	};
}

export async function fetchPwaAssetVersion(): Promise<string | null> {
	// The launch splash waits for this check, so a stalled server must fail it promptly.
	const response = await fetch(`/notifications/version.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
	if (!response.ok) return null;
	const result = await response.json() as { assetVersion?: string };
	return typeof result.assetVersion === 'string' && result.assetVersion.trim() ? result.assetVersion : null;
}

const REPLACED_VERSION_KEY = 'crate-pwa-replaced-version';
// While a deploy propagates, the server can still answer with the version an
// update just replaced. Offering it again would downgrade, and its install fails.
const REPLACED_VERSION_GRACE_MS = 10 * 60_000;

export function rememberReplacedPwaVersion(version: string): void {
	try { localStorage.setItem(REPLACED_VERSION_KEY, JSON.stringify({ version, at: Date.now() })); }
	catch { /* Without storage a propagating deploy can only offer the old version briefly. */ }
}

export function wasPwaVersionJustReplaced(version: string): boolean {
	try {
		const stored = JSON.parse(localStorage.getItem(REPLACED_VERSION_KEY) ?? 'null') as { version?: unknown; at?: unknown } | null;
		return stored?.version === version && typeof stored.at === 'number' && Date.now() - stored.at < REPLACED_VERSION_GRACE_MS;
	} catch { return false; }
}
