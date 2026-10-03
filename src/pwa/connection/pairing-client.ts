import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../protocol';
import { PAIRING_PATH, PairingEndedError, type PairingTransport } from '../../encryption/pairing/protocol';
import { parseScopedEncryptionState, type ScopedEncryptionState } from '../encryption-scope';
import { AUTH_TOKEN_KEY, loadStoredConfig } from '../config';
import { READING_SESSION_KEY, readingSession } from '../reading/storage';
import { capturePwaSession } from '../session-generation';
import { reportExpiredConnection } from './expiration';

export function pairingConnection(feature: 'reading' | 'reminders', signal: AbortSignal) {
  const reading = readingSession();
  const token = feature === 'reading' ? reading?.token : localStorage.getItem(AUTH_TOKEN_KEY);
  const localFolder = feature === 'reading' ? reading?.folderPath : loadStoredConfig().folderPath;
  const readingIdentity = localStorage.getItem(READING_SESSION_KEY);
  const remindersToken = localStorage.getItem(AUTH_TOKEN_KEY);
  const sessionCurrent = capturePwaSession();
  const assertSession = () => {
    if (!token || !localFolder || !sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== remindersToken
      || localStorage.getItem(READING_SESSION_KEY) !== readingIdentity
      || feature === 'reminders' && loadStoredConfig().folderPath !== localFolder) throw new PairingEndedError('The app connection changed. Start again.');
  };
  const current = () => { signal.throwIfAborted(); assertSession(); };
  async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    current();
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    current();
    if (response.status === 401) reportExpiredConnection(token!);
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw Object.assign(new Error(response.status === 404 ? 'Update your Crate server in Obsidian to connect without a recovery key.' : data.error ?? 'Could not connect. Try again.'), { status: response.status });
    return data;
  }
  const transport: PairingTransport = {
    read: id => request(`${PAIRING_PATH}${id ? `?id=${encodeURIComponent(id)}` : ''}`),
    write: body => request(PAIRING_PATH, body),
  };
  return { current, transport, localFolder: localFolder!, async cancel(id: string) {
    assertSession();
    await fetch(PAIRING_PATH, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) }, body: JSON.stringify({ action: 'cancel', id }) });
  }, async encryption(): Promise<ScopedEncryptionState> {
    const result = await request<{ encryption: unknown }>(feature === 'reading' ? '/reading/encryption' : '/encryption');
    const state = parseScopedEncryptionState(result.encryption, feature);
    if (state.mode !== 'active') throw new Error('Finish encryption setup in Obsidian first.');
    return state;
  } };
}
