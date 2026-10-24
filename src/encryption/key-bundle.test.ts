import { describe, expect, it } from 'vitest';
import { createVaultKeyBundle, generateRecoveryCode, openRecoveryBundle, sealRecoveryBundle, validateVaultKeyBundle } from './key-bundle';

describe('encryption key ownership and recovery', () => {
	it('recovers vault and notification keys using only the recovery code and encrypted backup', async () => {
		const bundle = await createVaultKeyBundle();
		const code = await generateRecoveryCode();
		const sealed = await sealRecoveryBundle(bundle, code);
		expect(JSON.stringify(sealed)).not.toContain(bundle.vault.secret);
		expect(JSON.stringify(sealed)).not.toContain(bundle.notifications.secret);
		expect(JSON.stringify(sealed)).not.toContain(bundle.seal.privateKey);
		expect(await openRecoveryBundle(JSON.parse(JSON.stringify(sealed)), code)).toEqual(bundle);
		await expect(openRecoveryBundle(sealed, await generateRecoveryCode())).rejects.toThrow();
		await expect(openRecoveryBundle({ ...sealed, vaultId: 'another-vault' }, code)).rejects.toThrow();
		await expect(openRecoveryBundle(sealed, code.slice(0, -1) + '!')).rejects.toThrow();
	});

	it('refuses damaged, reused, and unsupported key bundles instead of generating replacement keys', async () => {
		const bundle = await createVaultKeyBundle();
		validateVaultKeyBundle(bundle);
		expect(() => validateVaultKeyBundle({ ...bundle, version: 2 })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, generation: 0 })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, notifications: bundle.vault })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, notifications: { ...bundle.notifications, secret: bundle.vault.secret } })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, seal: { ...bundle.seal, id: bundle.vault.id } })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, seal: { ...bundle.seal, publicKey: 'damaged' } })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, scopes: [] })).toThrow();
	});
});
