import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addReminderScope, createReminderKeyGrant, createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { rememberPairingGrants, rememberRecoveryKey } from './web-app-unlock';
import { bindEncryptionScopes } from '../encryption/scope-binding';
import { createEncryptionState } from '../encryption/server-state';
import { rememberReminderKeys } from './encryption-keys';
import { AUTH_TOKEN_KEY, saveConfig } from './config';
import { READING_SESSION_KEY } from './reading/storage';
import type { ScopedEncryptionState } from './encryption-scope';
vi.mock('./encryption-keys', () => ({ rememberReminderKeys: vi.fn(async () => {}) }));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.mocked(rememberReminderKeys).mockClear();
  localStorage.setItem(AUTH_TOKEN_KEY, 'reminders-session');
  saveConfig({ folderPath: 'Old reminders', upcomingDays: 7, allDayNotificationTime: null });
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify({ token: 'reading-token', id: 'reading-session', folderPath: 'Old reading', generation: 'policy', expiresAt: Date.now() + 100000 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture(primary: 'Reminders' | 'Reading' = 'Reminders') {
  const code = await generateRecoveryCode();
  const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
  const grants = ['Reminders', 'Reading'].map(folder => createReminderKeyGrant(bundle, folder));
  const grant = grants.find(grant => grant.scope.folderPath === primary)!;
  const expected: ScopedEncryptionState = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation, mode: 'active', recovery: await sealRecoveryBundle(bundle, code),
    scope: { id: grant.scope.id, folderPath: primary, purpose: grant.scope.purpose, keyId: grant.scope.data.id, notificationKeyId: grant.scope.notifications.id } };
  return { bundle, grants, expected, code };
}
it.each(['Reminders', 'Reading'] as const)('imports both folders from %s while preserving each original local namespace', async feature => {
  const f = await fixture(feature);
  await rememberRecoveryKey(f.code, f.expected, feature === 'Reading' ? 'Old reading' : 'Old reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledTimes(2);
  expect(rememberReminderKeys).toHaveBeenNthCalledWith(1, f.grants[0], expect.any(Function), 'Old reminders');
  expect(rememberReminderKeys).toHaveBeenNthCalledWith(2, f.grants[1], expect.any(Function), 'Old reading');
});
it('rejects another vault before persisting any keys', async () => {
  const f = await fixture(); f.expected.vaultId = crypto.randomUUID();
  await expect(rememberRecoveryKey(f.code, f.expected, 'Reminders', () => true)).rejects.toThrow('does not match');
  expect(rememberReminderKeys).not.toHaveBeenCalled();
});
it.each(['reminders', 'reading', 'caller'])('stops a stale import when the %s session changes', async feature => {
  const f = await fixture(); let active = true;
  vi.mocked(rememberReminderKeys).mockImplementationOnce(async (_grant, current) => {
    if (feature === 'reminders') localStorage.setItem(AUTH_TOKEN_KEY, 'new-session');
    if (feature === 'reading') localStorage.removeItem(READING_SESSION_KEY);
    if (feature === 'caller') active = false;
    expect(current!()).toBe(false);
    throw new Error('Session changed');
  });
  await expect(rememberRecoveryKey(f.code, f.expected, 'Reminders', () => active)).rejects.toThrow('Session changed');
  expect(rememberReminderKeys).toHaveBeenCalledOnce();
});
it('supports an enrollment for one feature without depending on sibling session data', async () => {
  const f = await fixture(); localStorage.setItem(READING_SESSION_KEY, 'damaged');
  f.bundle.scopes = [f.bundle.scopes[0]!];
  f.expected.recovery = await sealRecoveryBundle(f.bundle, f.code);
  await rememberRecoveryKey(f.code, f.expected, 'Reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledOnce();
});

it.each(['wrong key', 'tampered bundle', 'generation', 'scope', 'access identity', 'data key', 'notification key', 'converting', 'resetting', 'old server'] as const)('rejects %s before persisting keys', async change => {
  const f = await fixture();
  if (change === 'wrong key') f.code = await generateRecoveryCode();
  if (change === 'tampered bundle') f.expected.recovery!.envelope += 'a';
  if (change === 'generation') f.expected.generation++;
  if (change === 'scope') f.expected.scope.id = crypto.randomUUID();
  if (change === 'access identity') f.expected.scope.accessId = crypto.randomUUID();
  if (change === 'data key') f.expected.scope.keyId = crypto.randomUUID();
  if (change === 'notification key') f.expected.scope.notificationKeyId = crypto.randomUUID();
  if (change === 'converting' || change === 'resetting') f.expected.mode = change;
  if (change === 'old server') delete f.expected.recovery;
  await expect(rememberRecoveryKey(f.code, f.expected, 'Reminders', () => true)).rejects.toThrow();
  expect(rememberReminderKeys).not.toHaveBeenCalled();
});

it('accepts the saved recovery code with surrounding whitespace', async () => {
  const f = await fixture();
  await rememberRecoveryKey(` ${f.code}\n`, f.expected, 'Reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledTimes(2);
});

it('does not persist root keys or unrelated folders from the recovered vault bundle', async () => {
  const f = await fixture();
  f.bundle = addReminderScope(f.bundle, 'Private reminders');
  f.expected.generation = f.bundle.generation;
  f.expected.recovery = await sealRecoveryBundle(f.bundle, f.code);
  await rememberRecoveryKey(f.code, f.expected, 'Reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledTimes(2);
  const stored = JSON.stringify(vi.mocked(rememberReminderKeys).mock.calls);
  expect(stored).not.toContain(f.bundle.vault.secret);
  expect(stored).not.toContain(f.bundle.scopes[2]!.data.secret);
});

it('selects the connected Reminders folder when a Reading recovery bundle contains several candidates', async () => {
  const f = await fixture('Reading');
  f.bundle = addReminderScope(f.bundle, 'Private reminders');
  f.expected.generation = f.bundle.generation;
  f.expected.recovery = await sealRecoveryBundle(f.bundle, f.code);
  saveConfig({ folderPath: 'Reminders', upcomingDays: 7, allDayNotificationTime: null });
  await rememberRecoveryKey(f.code, f.expected, 'Old reading', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledTimes(2);
  expect(vi.mocked(rememberReminderKeys).mock.calls.map(([grant]) => grant.scope.folderPath)).toEqual(['Reminders', 'Reading']);
});

it('does not guess a sibling folder when several scopes exist after a rename', async () => {
  const f = await fixture('Reading');
  f.bundle = addReminderScope(f.bundle, 'Private reminders');
  f.expected.generation = f.bundle.generation;
  f.expected.recovery = await sealRecoveryBundle(f.bundle, f.code);
  await rememberRecoveryKey(f.code, f.expected, 'Old reading', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledOnce();
  expect(vi.mocked(rememberReminderKeys).mock.calls[0]![0].scope.folderPath).toBe('Reading');
});

async function pairingFixture() {
  const f = await fixture();
  const state = await bindEncryptionScopes(createEncryptionState(f.bundle, f.expected.recovery!), f.bundle);
  f.expected.scope = state.scopes[0]!;
  return f;
}
it('imports approved browser grants into both original local namespaces', async () => {
  const f = await pairingFixture();
  await rememberPairingGrants({ grants: f.grants }, f.expected, 'Old reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenNthCalledWith(1, f.grants[0], expect.any(Function), 'Old reminders');
  expect(rememberReminderKeys).toHaveBeenNthCalledWith(2, f.grants[1], expect.any(Function), 'Old reading');
});
it.each(['secret', 'vault', 'generation', 'duplicate', 'missing primary', 'root keys', 'missing binding', 'stale session'] as const)('rejects a pairing transfer with %s before storing keys', async problem => {
  const f = await pairingFixture();
  const packet: { grants: typeof f.grants; vault?: unknown } = { grants: f.grants };
  if (problem === 'secret') f.grants[0]!.scope.data.secret = createVaultKeyBundle().vault.secret;
  if (problem === 'vault') f.grants[1]!.vaultId = crypto.randomUUID();
  if (problem === 'generation') f.grants[1]!.generation++;
  if (problem === 'duplicate') packet.grants = [f.grants[0]!, f.grants[0]!];
  if (problem === 'missing primary') packet.grants = [f.grants[1]!];
  if (problem === 'root keys') packet.vault = f.bundle.vault;
  if (problem === 'missing binding') delete f.expected.scope.binding;
  await expect(rememberPairingGrants(packet, f.expected, 'Old reminders', () => problem !== 'stale session')).rejects.toThrow();
  expect(rememberReminderKeys).not.toHaveBeenCalled();
});
it('stops a pairing import if the connection changes between scope writes', async () => {
  const f = await pairingFixture();
  vi.mocked(rememberReminderKeys).mockImplementationOnce(async () => { localStorage.removeItem(READING_SESSION_KEY); return undefined as never; });
  await expect(rememberPairingGrants({ grants: f.grants }, f.expected, 'Old reminders', () => true)).rejects.toThrow('connection changed');
  expect(rememberReminderKeys).toHaveBeenCalledOnce();
});
