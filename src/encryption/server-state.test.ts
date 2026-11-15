import { describe, expect, it } from 'vitest';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle, type VaultKeyBundle } from './key-bundle';
import { generateEncryptionSecret } from './envelope';
import { generateSealKeyPair } from './seal-key';
import { assertEncryptionKeys, createEncryptionState, validateEncryptionState, type EncryptionServerState } from './server-state';

async function setup() {
	const bundle = await createVaultKeyBundle();
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	return { bundle, state };
}

describe('public encryption configuration', () => {
	it('publishes only key identities, the seal public key and the sealed recovery bundle', async () => {
		const { bundle, state } = await setup();
		expect(state).toMatchObject({ version: 1, vaultId: bundle.vaultId, generation: 1, mode: 'active', keyId: bundle.vault.id,
			notificationKeyId: bundle.notifications.id, seal: { keyId: bundle.seal.id, publicKey: bundle.seal.publicKey } });
		const json = JSON.stringify(state);
		for (const secret of [bundle.vault.secret, bundle.notifications.secret, bundle.seal.privateKey]) expect(json).not.toContain(secret);
		expect(() => validateEncryptionState(JSON.parse(json))).not.toThrow();
		expect(() => validateEncryptionState({ ...state, mode: 'resetting' })).not.toThrow();
	});

	it.each<[string, (state: EncryptionServerState) => unknown, string]>([
		['a non-object', () => [], 'Invalid encryption configuration'],
		['an extra field', state => ({ ...state, secret: 'x' }), 'Unexpected encryption configuration field'],
		['version 2', state => ({ ...state, version: 2 }), 'Unsupported encryption configuration'],
		['an invalid vault ID', state => ({ ...state, vaultId: 'a/b' }), 'Unsupported encryption configuration'],
		['generation 0', state => ({ ...state, generation: 0 }), 'Unsupported encryption configuration'],
		['an unknown mode', state => ({ ...state, mode: 'off' }), 'Unsupported encryption configuration'],
		['a missing seal key', state => ({ ...state, seal: undefined }), 'Missing vault seal key'],
		['a seal private key', state => ({ ...state, seal: { ...state.seal, privateKey: 'x' } }), 'Unexpected encryption configuration field'],
		['an invalid seal key ID', state => ({ ...state, seal: { ...state.seal, keyId: '' } }), 'Invalid vault seal key'],
		['a damaged seal public key', state => ({ ...state, seal: { ...state.seal, publicKey: 'A'.repeat(87) } }), 'Invalid public key.'],
		['a reused key ID', state => ({ ...state, notificationKeyId: state.keyId }), 'Duplicate encryption key'],
		['a key ID named vault', state => ({ ...state, keyId: 'vault' }), 'Duplicate encryption key'],
		['a missing recovery bundle', state => ({ ...state, recovery: null }), 'Missing encrypted recovery bundle'],
		['a recovery field', state => ({ ...state, recovery: { ...state.recovery, code: 'x' } }), 'Unexpected encryption configuration field'],
		['another vault\'s recovery bundle', state => ({ ...state, recovery: { ...state.recovery, vaultId: 'other' } }), 'Invalid encrypted recovery bundle'],
	])('rejects a configuration with %s', async (_, change, message) => {
		const { state } = await setup();
		expect(() => validateEncryptionState(change(state))).toThrow(message);
	});

	it('unlocks only with keys matching every published identity', async () => {
		const { bundle, state } = await setup();
		expect(() => assertEncryptionKeys(state, bundle)).not.toThrow();
		const seal = await generateSealKeyPair();
		const changes: Partial<VaultKeyBundle>[] = [{ vaultId: 'other' }, { generation: 2 }, { vault: generateEncryptionSecret() },
			{ notifications: generateEncryptionSecret() }, { seal: { ...bundle.seal, id: seal.id } }, { seal: { ...bundle.seal, publicKey: seal.publicKey } }];
		for (const change of changes) expect(() => assertEncryptionKeys(state, { ...bundle, ...change })).toThrow('Recover this server’s encryption keys before continuing');
	});
});
