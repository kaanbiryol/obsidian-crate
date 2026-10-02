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
