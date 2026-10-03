import { describe, expect, it } from 'vitest';
import { addReminderScope, createReminderKeyGrant, createVaultKeyBundle, generateRecoveryCode, openRecoveryBundle, sealRecoveryBundle, validateReminderKeyGrant, validateVaultKeyBundle } from './key-bundle';

describe('encryption key ownership and recovery', () => {
	it('recovers vault and reminder keys using only the recovery code and encrypted backup', async () => {
		const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
		const code = await generateRecoveryCode();
		const sealed = await sealRecoveryBundle(bundle, code);
		expect(JSON.stringify(sealed)).not.toContain(bundle.vault.secret);
		expect(JSON.stringify(sealed)).not.toContain(bundle.scopes[0]!.data.secret);
		expect(await openRecoveryBundle(JSON.parse(JSON.stringify(sealed)), code)).toEqual(bundle);
		await expect(openRecoveryBundle(sealed, await generateRecoveryCode())).rejects.toThrow();
		await expect(openRecoveryBundle({ ...sealed, vaultId: 'another-vault' }, code)).rejects.toThrow();
		await expect(openRecoveryBundle(sealed, code.slice(0, -1) + '!')).rejects.toThrow();
	});

	it('grants exactly one reminder scope without the vault or another folder key', () => {
		const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Personal'), 'Work');
		const grant = createReminderKeyGrant(bundle, 'Personal');
		validateReminderKeyGrant(grant);
		expect(grant.scope.folderPath).toBe('Personal');
		expect(JSON.stringify(grant)).not.toContain(bundle.vault.secret);
		expect(JSON.stringify(grant)).not.toContain(bundle.scopes[1]!.data.secret);
		expect(() => validateReminderKeyGrant({ ...grant, vault: bundle.vault })).toThrow();
		grant.scope.data.secret = 'changed';
		expect(bundle.scopes[0]!.data.secret).not.toBe('changed');
		expect(() => createReminderKeyGrant(bundle, 'Missing')).toThrow();
	});

	it('refuses damaged, reused, and unsupported key bundles instead of generating replacement keys', () => {
		const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
		expect(() => validateVaultKeyBundle({ ...bundle, version: 2 })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, generation: 0 })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, scopes: [...bundle.scopes, ...bundle.scopes] })).toThrow();
		expect(() => validateVaultKeyBundle({ ...bundle, scopes: [{ ...bundle.scopes[0], data: bundle.vault }] })).toThrow();
		expect(() => addReminderScope(bundle, '../private')).toThrow();
		expect(addReminderScope(bundle, 'Reminders')).toBe(bundle);
	});
});
