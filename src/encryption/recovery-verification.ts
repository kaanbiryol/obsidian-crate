import { openRecoveryBundle, sameVaultKeyBundle, type RecoveryEnvelope, type VaultKeyBundle } from './key-bundle';

/** Check the saved copy by recovering every secret, not just matching key IDs. */
export async function verifyRecoveryCode(envelope: RecoveryEnvelope, code: string, expected: VaultKeyBundle): Promise<void> {
	const recovered = await openRecoveryBundle(envelope, code);
	if (!sameVaultKeyBundle(recovered, expected)) throw new Error('This recovery key does not restore all of this vault’s current keys.');
}
