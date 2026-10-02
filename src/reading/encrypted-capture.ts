import type CratePlugin from '../plugin/CratePlugin';
import { captureServerConnection } from '../plugin/server-request';
import { loadEncryptionKeys } from '../plugin/encryption-storage';
import { SECRET_KEYS } from '../plugin/settings-types';
import { FileKeyAuthority } from '@/encryption/file-authority';
import { WorkerApiHttpClient, HttpError } from '@/sync/worker-api/http';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { EncryptedReadingApi } from './encrypted-api';

export async function removeEncryptedReadingCapture(plugin: CratePlugin, operationId: string): Promise<void> {
  const keys = loadEncryptionKeys(plugin.secretStorage);
  if (!keys) return;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw new Error('Invalid operation ID.');
  const connection = captureServerConnection(plugin);
  const path = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/reading-encrypted-attempts/${keys.vaultId}-${operationId}.json`;
  const adapter = plugin.app.vault.adapter;
  if (await adapter.exists(path)) { connection.assertCurrent(); await adapter.remove(path); }
}

/** Finish immutable captures queued by older mobile clients without sending their
 * plaintext request again. The regular sync then brings the resulting note home. */
export async function sendEncryptedReadingCapture(plugin: CratePlugin, body: unknown): Promise<unknown> {
  const connection = captureServerConnection(plugin), keys = loadEncryptionKeys(plugin.secretStorage);
  if (!keys) throw new Error('Unlock this vault before sending pending Reading captures.');
  const token = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) ?? '';
  const http = new WorkerApiHttpClient(plugin.settings.workerUrl, token);
  http.setAbortSignal(getPluginLifecycleSignal(plugin)); http.setEncryptionAuthority(keys.vaultId, keys.generation);
  const folderPath = plugin.settings.reading.folderPath;
  const authority = (await FileKeyAuthority.fromVault(keys)).forPath(folderPath + '/receipt.md');
  const directory = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/reading-encrypted-attempts`;
  const file = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid operation ID.'); return `${directory}/${keys.vaultId}-${id}.json`; };
  const adapter = plugin.app.vault.adapter;
  const api = new EncryptedReadingApi({ folderPath, generation: keys.generation, authority,
    request: async (path, wire) => { connection.assertCurrent(); const result = await http.requestBinary(path, { method: wire ? 'POST' : 'GET', ...(wire ? { body: wire, contentType: 'application/json' } : {}) }); connection.assertCurrent(); return new Response(result.body, { headers: result.headers }); },
    readAttempt: async id => { connection.assertCurrent(); return await adapter.exists(file(id)) ? JSON.parse(await adapter.read(file(id))) as unknown : undefined; },
    writeAttempt: async (id, attempt) => { connection.assertCurrent(); if (!await adapter.exists(directory)) await adapter.mkdir(directory); const json = JSON.stringify(attempt); connection.assertCurrent(); await adapter.write(file(id), json); if (await adapter.read(file(id)) !== json) throw new Error('Could not verify encrypted Reading attempt.'); },
    error: (message, status) => new HttpError(message, status),
  });
  return api.request('/reading/capture', JSON.stringify(body));
}
