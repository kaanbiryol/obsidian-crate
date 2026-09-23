import { parseCrateServerInfo } from '../protocol';

export const SERVER_CHECK_TIMEOUT_MS = 6_000;

/** A public, read-only probe. Browser fetch can be cancelled; Obsidian requestUrl cannot. */
export async function checkServerReachability(address: string, signal: AbortSignal): Promise<string | null> {
	const url = `${address.replace(/\/$/, '')}/.well-known/crate`;
	let response: Response;
	try {
		// Obsidian requestUrl cannot cancel a DNS request during startup.
		response = await window.fetch(url, { signal, cache: 'no-store' });
	} catch {
		if (signal.aborted) return null;
		// Some self-hosted reverse proxies omit CORS headers. An opaque response
		// still proves that the address resolves without treating CORS as downtime.
		try {
			await window.fetch(url, { signal, cache: 'no-store', mode: 'no-cors' });
			return null;
		} catch {
			if (signal.aborted) return null;
			return new URL(address).hostname.endsWith('.trycloudflare.com')
				? 'Cannot reach the temporary tunnel address. Check the latest HTTPS address in your server logs.'
				: 'Cannot reach the saved server address. Check the address and your internet connection.';
		}
	}
	if (!response.ok) {
		if ([502, 503, 504].includes(response.status) && new URL(address).hostname.endsWith('.trycloudflare.com')) {
			return 'The tunnel cannot reach Crate. Check that your server is running.';
		}
		return `The sync server returned HTTP ${response.status}. Check that Crate is running at the saved address.`;
	}
	try {
		if (!parseCrateServerInfo(await response.json())) return 'The saved address did not return a Crate server.';
	} catch {
		if (signal.aborted) return null;
		return 'The saved address did not return a Crate server.';
	}
	return null;
}
