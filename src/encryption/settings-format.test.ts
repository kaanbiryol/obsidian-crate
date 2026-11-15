import { expect, it } from 'vitest';
import { MAX_SHARED_SETTINGS_BYTES, validateEncryptedSettings } from './settings-format';

const settings = { version: 1, vaultId: 'vault-a', keyId: 'key-a', envelope: 'a.b.c.d.e' };

it('accepts only exact encrypted settings records', () => {
	expect(() => validateEncryptedSettings(settings)).not.toThrow();
	for (const value of [null, [], 'a.b.c.d.e']) expect(() => validateEncryptedSettings(value)).toThrow('Invalid encrypted settings');
	for (const value of [{ ...settings, plaintext: '{}' }, { ...settings, version: 2 }, { ...settings, vaultId: '' }, { ...settings, keyId: 'a b' },
		{ ...settings, envelope: 'a.b.c.d' }, { ...settings, envelope: 5 }, { ...settings, envelope: 'a.b.c.d.' + 'e'.repeat(Math.ceil(MAX_SHARED_SETTINGS_BYTES * 4 / 3) + 4096) }]) {
		expect(() => validateEncryptedSettings(value)).toThrow('Unsupported encrypted settings');
	}
});
