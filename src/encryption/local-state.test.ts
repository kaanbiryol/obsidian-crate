import { expect, it } from 'vitest';
import { LocalStateCipher } from './local-state';

it('protects pending changes synchronously with unique nonces and a bound storage identity', () => {
	const key = crypto.getRandomValues(new Uint8Array(32));
	const cipher = new LocalStateCipher('vault', 'scope', key);
	const first = cipher.seal('Private unfinished draft 🦉', 'draft:a');
	expect(first).not.toContain('Private');
	expect(cipher.seal('Private unfinished draft 🦉', 'draft:a')).not.toBe(first);
	expect(cipher.open(first, 'draft:a')).toBe('Private unfinished draft 🦉');
	expect(() => cipher.open(first, 'draft:b')).toThrow();
	expect(() => new LocalStateCipher('other-vault', 'scope', key).open(first, 'draft:a')).toThrow();
	expect(() => cipher.open(first.slice(0, -3) + 'AAA', 'draft:a')).toThrow();
	expect(() => cipher.open('{"oldPlaintext":true}', 'draft:a')).toThrow();
	cipher.destroy();
	expect(() => cipher.open(first, 'draft:a')).toThrow('locked');
});

it('refuses invalid keys and damaged or oversized browser data', () => {
	const key = crypto.getRandomValues(new Uint8Array(32));
	expect(() => new LocalStateCipher('vault', 'scope', key.slice(0, 31))).toThrow('Invalid local encryption key');
	expect(() => new LocalStateCipher('a/b', 'scope', key)).toThrow('Invalid local encryption key');
	expect(() => new LocalStateCipher('vault', '', key)).toThrow('Invalid local encryption key');
	const cipher = new LocalStateCipher('vault', 'scope', key);
	key.fill(0);
	const sealed = cipher.seal('draft', 'draft:a');
	expect(cipher.open(sealed, 'draft:a')).toBe('draft');
	const [nonce, body] = sealed.slice('crate-local-e2ee-v1.'.length).split('.');
	expect(() => cipher.open(`crate-local-e2ee-v1.${nonce}`, 'draft:a')).toThrow('Damaged encrypted browser data');
	expect(() => cipher.open(`crate-local-e2ee-v1.${nonce}.${body}.extra`, 'draft:a')).toThrow('Damaged encrypted browser data');
	expect(() => cipher.open(`crate-local-e2ee-v1.${'A'.repeat(31)}.${body}`, 'draft:a')).toThrow('Damaged encrypted browser data');
	expect(() => cipher.seal('x'.repeat(16 * 1024 * 1024 + 1), 'draft:a')).toThrow('Private browser data exceeds its storage limit');
	cipher.destroy();
	expect(() => cipher.seal('draft', 'draft:a')).toThrow('locked');
});
