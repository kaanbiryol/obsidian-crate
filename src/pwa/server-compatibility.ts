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

/** Fetched per mutation: operation ids take the server's current day from this response. */
export async function requireCompatibleProtocol(): Promise<number> {
  const info = await requireCompatibleServer();
  return Math.min(CRATE_PLUGIN_PROTOCOL.current, info.protocol.current);
}
