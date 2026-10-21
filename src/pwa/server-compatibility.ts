import { CRATE_PLUGIN_PROTOCOL, isCompatibleCrateServer, parseCrateServerInfo, type CrateServerInfo } from '@/protocol/server-info';

export async function requireCompatibleServer(): Promise<CrateServerInfo> {
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
