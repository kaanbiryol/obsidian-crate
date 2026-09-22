import type CratePlugin from '../plugin/CratePlugin';
import { SECRET_KEYS } from '../plugin/settings-types';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';

export interface ServerReadingPolicy { enabled: number; folder_path: string; generation: string; revision: string }
export async function readingServerRequest<T>(plugin: CratePlugin, path: string, body?: unknown): Promise<T> {
  const origin = plugin.settings.workerUrl, token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
  if (!origin || !token) throw new Error('Connect Crate to your server first.');
  const client = new WorkerApiHttpClient(origin, token);
  const info = await client.requestJson<{ capabilities: string[] }>('/.well-known/crate');
  if (!info.capabilities.includes('reading-v1')) throw new Error('Update your Crate server to enable web Reading and phone saves.');
  const result = await client.requestJson<T>(path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
  getPluginLifecycleSignal(plugin).throwIfAborted();
  if (plugin.settings.workerUrl !== origin || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== token) throw new Error('The server connection changed. Open Reading settings again.');
  return result;
}
