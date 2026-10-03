import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EncryptionKeyRequiredError, rememberEncryptionUnlock } from './encryption-onboarding';
import { clearEncryptionSessionMarkers } from './encryption-cleanup';

beforeEach(() => {
  const values: Record<string, string> = {};
  vi.stubGlobal('localStorage', Object.defineProperties(values, {
    getItem: { value: (key: string) => values[key] ?? null },
    setItem: { value: (key: string, value: string) => { values[key] = value; } },
    removeItem: { value: (key: string) => { delete values[key]; } },
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('keeps a completed setup distinct from another vault or a failed first unlock', () => {
  expect(new EncryptionKeyRequiredError('one').firstUnlock).toBe(true);
  expect(new EncryptionKeyRequiredError('one').firstUnlock).toBe(true);
  rememberEncryptionUnlock('one');
  expect(new EncryptionKeyRequiredError('one').firstUnlock).toBe(false);
  expect(new EncryptionKeyRequiredError('two').firstUnlock).toBe(true);
});

it('uses recovery presentation when onboarding history cannot be read', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Unavailable'); } });
  expect(new EncryptionKeyRequiredError('one').firstUnlock).toBe(false);
});

it('does not block a successful unlock if the optional marker cannot be saved', () => {
  vi.stubGlobal('localStorage', { setItem: () => { throw new Error('Quota'); } });
  expect(() => rememberEncryptionUnlock('one')).not.toThrow();
});

it('clears onboarding on explicit logout but preserves it for a stale cleanup', () => {
  rememberEncryptionUnlock('one');
  clearEncryptionSessionMarkers(() => false);
  expect(new EncryptionKeyRequiredError('one').firstUnlock).toBe(false);
  clearEncryptionSessionMarkers(() => true);
  expect(new EncryptionKeyRequiredError('one').firstUnlock).toBe(true);
});
