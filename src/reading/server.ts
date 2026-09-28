import type CratePlugin from '../plugin/CratePlugin';
import { SECRET_KEYS } from '../plugin/settings-types';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

export interface ServerReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string }
export async function readingServerRequest<T>(plugin: CratePlugin, path: string, body?: unknown): Promise<T> {
  const signal = getPluginLifecycleSignal(plugin);
  signal.throwIfAborted();
  const origin = plugin.settings.workerUrl, token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
  if (!origin || !token) throw new Error('Connect Crate to your server first.');
  const client = new WorkerApiHttpClient(origin, token);
  const timeout = path === '/features' ? 5_000 : 30_000;
  const info = await client.requestJson<{ capabilities: string[] }>('/.well-known/crate', {}, timeout);
  if (path === '/features' && !info.capabilities.includes('shared-features-v1')) throw new Error('Update your Crate server to share feature settings.');
  if (!info.capabilities.includes('reading-v1')) throw new Error('Update your Crate server to enable web Reading and phone saves.');
  if (path === '/reading/fetching' && !info.capabilities.includes('reading-fetching-consent-v1')) throw new Error('Update your Crate server to manage article fetching.');
  if (path === '/reading/capture' && !info.capabilities.includes('reading-deferred-captures-v1')) throw new Error('Update your Crate server to finish pending Reading saves.');
  const result = await client.requestJson<T>(path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }, timeout);
  signal.throwIfAborted();
  if (plugin.settings.workerUrl !== origin || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== token) throw new Error('The server connection changed. Open Reading settings again.');
  return result;
}
