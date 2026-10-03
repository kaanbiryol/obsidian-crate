import { afterEach, expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { SECRET_KEYS } from './settings-types';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { openWebAppPairing } from './web-app-pairing';
import { PAIRING_CAPABILITY, type PairingContext } from '../encryption/pairing/protocol';

const mocks = vi.hoisted(() => ({
  info: vi.fn(async () => ({ capabilities: ['web-pairing-v1'] })),
  request: vi.fn(async () => ({})),
  state: vi.fn(),
}));
vi.mock('../sync/worker-api/http', () => ({ obsidianHttpTransport: vi.fn(), WorkerApiHttpClient: class {
  setAbortSignal() {} setEncryptionAuthority() {}
  getServerInfo = mocks.info;
  requestJson = mocks.request;
} }));
vi.mock('../sync/encryption-conversion', async () => ({ ...await vi.importActual('../sync/encryption-conversion'), readServerEncryption: mocks.state }));
afterEach(() => { vi.clearAllMocks(); mocks.info.mockResolvedValue({ capabilities: [PAIRING_CAPABILITY] }); });
async function fixture() {
  const bundle = addReminderScope(addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading'), 'Private');
  const state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' as const };
  mocks.state.mockResolvedValue(state);
  const values = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'vault-token'], [SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)]]);
  const plugin = { settings: { workerUrl: 'https://server.test', reading: { folderPath: 'Reading' } }, remindersSettings: { remindersFolderPath: 'Reminders' },
    secretStorage: { get: (key: string) => values.get(key) ?? null } } as CratePlugin;
  const context: PairingContext = { version: 1, origin: plugin.settings.workerUrl, id: crypto.randomUUID(), vaultId: bundle.vaultId, generation: bundle.generation, scopeId: bundle.scopes[0]!.id };
  const controller = new AbortController();
  return { bundle, state, plugin, values, context, controller };
}
it('checks capability once and releases only the configured browser scopes', async () => {
  const f = await fixture();
  const session = await openWebAppPairing(f.plugin, f.controller.signal);
  expect(mocks.state).not.toHaveBeenCalled();
  await session.transport.read(); await session.transport.read();
  expect(mocks.info).toHaveBeenCalledOnce();
  const payload = await session.payload(f.context);
  expect(payload.grants.map(grant => grant.scope.folderPath)).toEqual(['Reminders','Reading']);
  expect(JSON.stringify(payload)).not.toContain(f.bundle.vault.secret);
  expect(JSON.stringify(payload)).not.toContain(f.bundle.scopes[2]!.data.secret);
});
it.each(['locked', 'old server', 'changed token', 'changed folder', 'changed keys', 'closed', 'wrong origin', 'new generation', 'resetting'] as const)('refuses key release for %s', async problem => {
  const f = await fixture();
  if (problem === 'locked') f.values.delete(SECRET_KEYS.ENCRYPTION_KEYS);
  if (problem === 'old server') mocks.info.mockResolvedValue({capabilities:[]});
  const work = async () => {
    const session = await openWebAppPairing(f.plugin, f.controller.signal);
    if (problem === 'changed token') f.values.set(SECRET_KEYS.AUTH_TOKEN, 'other');
    if (problem === 'changed folder') f.plugin.settings.reading.folderPath = 'Other';
    if (problem === 'changed keys') f.values.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(createVaultKeyBundle()));
    if (problem === 'closed') f.controller.abort();
    if (problem === 'wrong origin') f.context.origin = 'https://another.test';
    if (problem === 'new generation') mocks.state.mockResolvedValue({...f.state,generation:f.state.generation+1});
    if (problem === 'resetting') mocks.state.mockResolvedValue({...f.state,mode:'resetting'});
    await session.payload(f.context);
  };
  await expect(work()).rejects.toThrow();
});
it('fences a pending approval when the modal closes during its state read', async () => {
  const f = await fixture();
  const session = await openWebAppPairing(f.plugin, f.controller.signal);
  mocks.state.mockImplementationOnce(async () => { f.controller.abort(); return f.state; });
  await expect(session.payload(f.context)).rejects.toThrow();
  // Closing the UI can still cancel an accepted relay record.
  await session.cancel(f.context.id);
  expect(mocks.request).toHaveBeenCalledWith('/encryption/pairing', expect.objectContaining({ method: 'POST' }), 5000);
});
