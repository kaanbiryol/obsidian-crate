import { afterEach, expect, it } from 'vitest';
import { LocalStateCipher } from '@/encryption/local-state';
import { decodeReadingValue, encodeReadingValue, lockReadingStorage, unlockReadingStorage } from './private-storage';

afterEach(() => lockReadingStorage(false));

it('preserves a future envelope without interpreting even decryptable content', () => {
  unlockReadingStorage(new LocalStateCipher('vault', 'scope', new Uint8Array(32).fill(7)));
  const value = encodeReadingValue('draft:session', { url: 'https://private.example/article' }) as Record<string, unknown>;
  expect(decodeReadingValue('draft:session', value)).toEqual({ url: 'https://private.example/article' });
  const future = { ...value, encryptedReading: 2 };
  const original = JSON.stringify(future);
  expect(() => decodeReadingValue('draft:session', future)).toThrow('unsupported encryption format');
  expect(JSON.stringify(future)).toBe(original);
});
