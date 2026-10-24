import { expect, it } from 'vitest';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from './key-bundle';
import { verifyRecoveryCode } from './recovery-verification';

it('verifies the saved recovery code by recovering all vault and notification secrets', async () => {
	const bundle = await createVaultKeyBundle();
	const code = await generateRecoveryCode(), sealed = await sealRecoveryBundle(bundle, code);
	await expect(verifyRecoveryCode(sealed, ` ${code}\n`, bundle)).resolves.toBeUndefined();
	await expect(verifyRecoveryCode(sealed, await generateRecoveryCode(), bundle)).rejects.toThrow();
	await expect(verifyRecoveryCode(sealed, code, { ...bundle, generation: bundle.generation + 1 })).rejects.toThrow('does not restore');
	const damaged = structuredClone(bundle);
	damaged.notifications.secret = (await createVaultKeyBundle()).vault.secret;
	await expect(verifyRecoveryCode(sealed, code, damaged)).rejects.toThrow('does not restore');
	await expect(verifyRecoveryCode({ ...sealed, envelope: sealed.envelope.slice(0, -8) }, code, bundle)).rejects.toThrow();
});
