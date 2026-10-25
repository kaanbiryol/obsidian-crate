import type CratePlugin from './CratePlugin';
import { captureServerConnection } from './server-request';
import { loadEncryptionKeys } from '../sync/encryption/key-storage';
import { sameVaultKeyBundle } from '../encryption/key-bundle';
import { PAIRING_PATH, type PairingContext, type PairingTransport } from '../encryption/pairing/protocol';
import { obsidianHttpTransport, WorkerApiHttpClient } from '../sync/worker-api/http';
import { readServerEncryption } from '../sync/encryption/server-encryption';
import { assertEncryptionKeys } from '../encryption/server-state';

export async function openWebAppPairing(plugin: CratePlugin, signal: AbortSignal) {
  const connection = captureServerConnection(plugin);
  const keys = loadEncryptionKeys(plugin.secretStorage);
  if (!keys || !connection.origin || !connection.token) throw new Error('Unlock this Obsidian vault before connecting an app.');
  const current = () => {
    connection.assertCurrent(); signal.throwIfAborted();
    const latest = loadEncryptionKeys(plugin.secretStorage);
    if (!latest || !sameVaultKeyBundle(keys, latest)) throw new Error('The vault changed. Reopen Connect web app.');
  };
  const http = new WorkerApiHttpClient(connection.origin, connection.token, async request => {
    current(); try { return await obsidianHttpTransport(request); } finally { current(); }
  });
  http.setAbortSignal(AbortSignal.any([signal, connection.signal]));
  http.setEncryptionAuthority(keys.vaultId, keys.generation);
  const transport: PairingTransport = {
    read: id => http.requestJson(`${PAIRING_PATH}${id ? `?id=${encodeURIComponent(id)}` : ''}`, undefined, 10_000),
    write: body => http.requestJson(PAIRING_PATH, { method: 'POST', body: JSON.stringify(body) }, 10_000),
  };
  const validate = (context: PairingContext) => {
    current();
    if (context.origin !== new URL(connection.origin).origin || context.vaultId !== keys.vaultId || context.generation !== keys.generation) throw new Error('This app request does not match the unlocked vault.');
  };
  return { transport, current, validate, async cancel(id: string) {
    connection.assertCurrent();
    const cleanup = new WorkerApiHttpClient(connection.origin, connection.token!);
    cleanup.setAbortSignal(connection.signal);
    await cleanup.requestJson(PAIRING_PATH, { method: 'POST', body: JSON.stringify({ action: 'cancel', id }) }, 5000);
  }, async payload(context: PairingContext) {
    validate(context);
    const state = await readServerEncryption(http, 10_000);
    current();
    if (!state || state.mode !== 'active') throw new Error('Finish encryption setup before approving this app.');
    assertEncryptionKeys(state, keys);
    return { bundle: keys };
  } };
}
