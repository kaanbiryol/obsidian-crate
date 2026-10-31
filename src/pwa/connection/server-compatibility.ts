import { CRATE_PLUGIN_PROTOCOL, isCompatibleCrateServer, parseCrateServerInfo, type CrateServerInfo } from '@/protocol/server-info';

// One save reads server info for its operation ID and again for its protocol
// header milliseconds later. Reuse a recent success so both share one request.
const REUSE_MS = 5_000;
let recent: { at: number; info: Promise<CrateServerInfo> } | undefined;

export function requireCompatibleServer(): Promise<CrateServerInfo> {
	// Monotonic time, so a device clock change cannot extend reuse.
	if (recent && performance.now() - recent.at < REUSE_MS) return recent.info;
	const info = fetchCompatibleServer();
	const entry = { at: performance.now(), info };
	recent = entry;
	info.catch(() => { if (recent === entry) recent = undefined; });
	return info;
}

async function fetchCompatibleServer(): Promise<CrateServerInfo> {
	const response = await fetch('/.well-known/crate', { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
	const info = response.ok ? parseCrateServerInfo(await response.json()) : null;
	if (!info || !isCompatibleCrateServer(info)) throw new Error('Update the Crate server and reload this app before making changes.');
	return info;
}

// The page and the Worker that served it ship together, so the negotiated
// protocol holds for the page. The Worker refuses an out-of-range protocol
// with 428 protocol_incompatible, which clears it for the next change.
let negotiated: Promise<number> | undefined;

/** The protocol header for changes, negotiated once per page. */
export function requireCompatibleProtocol(): Promise<number> {
	if (negotiated) return negotiated;
	const protocol = requireCompatibleServer().then(info => Math.min(CRATE_PLUGIN_PROTOCOL.current, info.protocol.current));
	negotiated = protocol;
	protocol.catch(() => { if (negotiated === protocol) negotiated = undefined; });
	return protocol;
}

/** The server refused this page's protocol; the next change reads server info again. */
export function forgetCompatibleProtocol(): void {
	negotiated = undefined;
	recent = undefined;
}
