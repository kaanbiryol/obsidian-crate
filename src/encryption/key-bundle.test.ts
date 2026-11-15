import { describe, expect, it } from 'vitest';
import { createVaultKeyBundle, generateRecoveryCode, isRecoveryEnvelope, openRecoveryBundle, sameVaultKeyBundle, sealRecoveryBundle, validateVaultKeyBundle, type VaultKeyBundle } from './key-bundle';
import { generateEncryptionSecret } from './envelope';

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

	it('rejects damaged secrets and seal keys with a specific error', async () => {
		const bundle = await createVaultKeyBundle();
		for (const vault of [null, { ...bundle.vault, id: '' }, { ...bundle.vault, secret: 5 }, { ...bundle.vault, secret: 'AAAA' }, { ...bundle.vault, extra: 1 }]) {
			expect(() => validateVaultKeyBundle({ ...bundle, vault })).toThrow('Invalid encryption key bundle');
		}
		for (const seal of [null, { ...bundle.seal, privateKey: 'AAAA' }, { ...bundle.seal, id: 'a b' }, { ...bundle.seal, extra: 1 }]) {
			expect(() => validateVaultKeyBundle({ ...bundle, seal })).toThrow('Invalid seal key');
		}
		expect(() => validateVaultKeyBundle({ ...bundle, generation: '1' })).toThrow('Unsupported or damaged encryption key bundle');
		expect(() => validateVaultKeyBundle(null)).toThrow('Unsupported or damaged encryption key bundle');
	});

	it('compares bundles by every identity and secret', async () => {
		const bundle = await createVaultKeyBundle();
		expect(sameVaultKeyBundle(bundle, JSON.parse(JSON.stringify(bundle)) as VaultKeyBundle)).toBe(true);
		const other = await createVaultKeyBundle();
		for (const change of [{ generation: 2 }, { vault: { ...bundle.vault, secret: generateEncryptionSecret().secret } }, { notifications: other.notifications },
			{ seal: { ...bundle.seal, privateKey: other.seal.privateKey } }, { seal: { ...bundle.seal, publicKey: other.seal.publicKey } }]) {
			expect(sameVaultKeyBundle(bundle, { ...bundle, ...change })).toBe(false);
		}
	});

	it('rejects recovery codes with the wrong shape and envelopes from another vault', async () => {
		const bundle = await createVaultKeyBundle();
		const code = await generateRecoveryCode();
		expect(code).toMatch(/^crate-recovery-v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{8}$/);
		const sealed = await sealRecoveryBundle(bundle, code);
		expect(await openRecoveryBundle(sealed, `  ${code}\n`)).toEqual(bundle);
		for (const bad of ['', code.replace('crate-recovery-v1', 'crate-recovery-v2'), code.split('.').slice(0, 2).join('.'), `${code}.x`]) {
			await expect(openRecoveryBundle(sealed, bad)).rejects.toThrow('Invalid recovery key');
		}
		expect(isRecoveryEnvelope(sealed, bundle.vaultId)).toBe(true);
		expect(isRecoveryEnvelope(sealed, 'other')).toBe(false);
		expect(isRecoveryEnvelope({ ...sealed, envelope: 'a.b.c.d' })).toBe(false);
		await expect(openRecoveryBundle({ ...sealed, version: 2 }, code)).rejects.toThrow('Unsupported or damaged recovery bundle');
		await expect(sealRecoveryBundle({ ...bundle, version: 2 } as never, code)).rejects.toThrow('Unsupported or damaged encryption key bundle');
	});
});

