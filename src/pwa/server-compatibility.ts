import { isCompatibleCrateServer, parseCrateServerInfo, type CrateServerInfo } from '@/protocol';

export async function requireCompatibleServer(): Promise<CrateServerInfo> {
  const response = await fetch('/.well-known/crate', { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  const info = response.ok ? parseCrateServerInfo(await response.json()) : null;
  if (!info || !isCompatibleCrateServer(info)) throw new Error('Update the Crate server and reload this app before making changes.');
  return info;
}
