import { expect, it, vi } from 'vitest';
import { createEncryptionReset, loadEncryptionReset, resetRemoteEncryption, saveEncryptionReset, EncryptionResetRejectedError, verifyEncryptionResetAddress } from './encryption-reset';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { HttpError, type WorkerApiHttpClient } from './worker-api/http';
import { SECRET_KEYS } from '../plugin/settings-types';

async function checkpoint() {
	const bundle = createVaultKeyBundle();
	const state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' as const };
	return createEncryptionReset('https://server.test', 'old-token', state, true);
}

it('persists and verifies the replacement credential before any server mutation', async () => {
	const reset = await checkpoint();
	const values = new Map<string, string>();
	const storage = { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
	saveEncryptionReset(storage as never, reset);
	expect(loadEncryptionReset(storage as never)).toEqual(reset);
	expect(() => saveEncryptionReset({ ...storage, set: () => {} } as never, { ...reset, phase: 'upload' })).toThrow('verify');
	values.set(SECRET_KEYS.ENCRYPTION_RESET, '{}');
	expect(() => loadEncryptionReset(storage as never)).toThrow('invalid');
});

it.each(['begin', 'finish'])('resumes after a lost %s response without starting a second destructive reset', async lostAt => {
	const reset = await checkpoint();
	let started = false, complete = false, lost = false, starts = 0, wipes = 0;
	const create = (token: string) => ({
		getServerInfo: async () => ({ capabilities: ['e2ee-reset-v1'] }), setEncryptionAuthority: vi.fn(),
		requestJson: async (_path: string, options?: { method: string }) => {
			if (token === reset.replacementToken && !started) throw new HttpError('Unauthorized', 401);
			if (token === reset.oldToken) {
				if (started) throw new HttpError('Unauthorized', 401);
				started = true; starts++;
				if (lostAt === 'begin' && !lost) { lost = true; throw new Error('Lost response'); }
			} else if (options?.method === 'POST' && !complete) {
				complete = true; wipes++;
				if (lostAt === 'finish' && !lost) { lost = true; throw new Error('Lost response'); }
			}
			return { id: reset.id, vaultId: reset.vaultId, generation: reset.generation, complete };
		},
	} as unknown as WorkerApiHttpClient);
	await expect(resetRemoteEncryption(reset, () => {}, () => {}, create, () => {})).rejects.toThrow('Lost response');
	await resetRemoteEncryption(reset, () => {}, () => {}, create, () => {});
	await resetRemoteEncryption(reset, () => {}, () => {}, create, () => {});
	expect(starts).toBe(1); expect(wipes).toBe(1);
});

it('does not fall back to destructive initiation on server errors or a changed connection', async () => {
	const reset = await checkpoint();
	const create = vi.fn(() => ({ requestJson: async () => { throw new HttpError('Unavailable', 503); } } as unknown as WorkerApiHttpClient));
	await expect(resetRemoteEncryption(reset, () => {}, () => {}, create, () => {})).rejects.toThrow('Unavailable');
	expect(create).toHaveBeenCalledTimes(1);
	create.mockClear();
	await expect(resetRemoteEncryption(reset, () => {}, () => { throw new Error('Connection changed'); }, create, () => {})).rejects.toThrow('Connection changed');
	expect(create).toHaveBeenCalledTimes(1);
});

it.each([400, 401, 403, 409, 428])('records a definitive first begin rejection (%s) before releasing the checkpoint', async status => {
	const reset = await checkpoint();
	const persisted: string[] = [];
	const create = (token: string) => ({
		getServerInfo: async () => ({ capabilities: ['e2ee-reset-v1'] }), setEncryptionAuthority: vi.fn(),
		requestJson: async () => {
			if (token === reset.replacementToken) throw new HttpError('Unauthorized', 401);
			expect(persisted).toEqual(['attempted']);
			throw new HttpError('Rejected', status);
		},
	} as unknown as WorkerApiHttpClient);
	await expect(resetRemoteEncryption(reset, () => {}, () => {}, create, value => persisted.push(value.beginState!)))
		.rejects.toBeInstanceOf(EncryptionResetRejectedError);
	expect(persisted).toEqual(['attempted', 'rejected']);
	const noNetwork = vi.fn(create);
	await expect(resetRemoteEncryption(reset, () => {}, () => {}, noNetwork, () => {})).rejects.toBeInstanceOf(EncryptionResetRejectedError);
	expect(noNetwork).not.toHaveBeenCalled();
});

it.each(['attempted', undefined] as const)('retains uncertain or older checkpoints when both credentials are rejected (%s)', async beginState => {
	const reset = { ...await checkpoint(), beginState };
	const create = () => ({ getServerInfo: async () => ({ capabilities: ['e2ee-reset-v1'] }), setEncryptionAuthority: vi.fn(),
		requestJson: async () => { throw new HttpError('Unauthorized', 401); },
	} as unknown as WorkerApiHttpClient);
	await expect(resetRemoteEncryption(reset, () => {}, () => {}, create, () => {})).rejects.toBeInstanceOf(HttpError);
	expect(reset.beginState).toBe('attempted');
});

it('does not dispatch begin if its attempted checkpoint cannot be saved', async () => {
	const reset = await checkpoint();
	const request = vi.fn(async () => { throw new HttpError('Unauthorized', 401); });
	const create = () => ({ getServerInfo: async () => ({ capabilities: ['e2ee-reset-v1'] }), setEncryptionAuthority: vi.fn(), requestJson: request } as unknown as WorkerApiHttpClient);
	await expect(resetRemoteEncryption(reset, () => {}, () => {}, create, () => { throw new Error('Storage failed'); })).rejects.toThrow('Storage failed');
	expect(request).toHaveBeenCalledTimes(1);
});

it.each(['remote', 'local', 'upload'] as const)('verifies relocation using the exact replacement-token receipt in phase %s', async phase => {
	const reset = { ...await checkpoint(), phase };
	const requestJson = vi.fn(async () => ({ ...reset, complete: phase !== 'remote' }));
	const create = vi.fn(() => ({ requestJson } as unknown as WorkerApiHttpClient));
	await verifyEncryptionResetAddress(reset, create);
	expect(create).toHaveBeenCalledExactlyOnceWith(reset.replacementToken);
	expect(requestJson).toHaveBeenCalledExactlyOnceWith(`/encryption/reset?id=${reset.id}`);
	requestJson.mockResolvedValueOnce({ ...reset, id: 'another-reset', complete: true });
	await expect(verifyEncryptionResetAddress(reset, create)).rejects.toThrow('did not confirm');
});

it('allows relocation before begin only if the original credential identifies the active encrypted vault', async () => {
	const reset = await checkpoint();
	// Only the identity fields are relevant here; readServerEncryption validates the full state.
	const bundle = createVaultKeyBundle();
	const active = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' as const };
	reset.vaultId = active.vaultId; reset.generation = active.generation;
	const create = (token: string) => ({ requestJson: async () => {
		if (token === reset.replacementToken) throw new HttpError('Unauthorized', 401);
		return { encryption: active };
	} } as unknown as WorkerApiHttpClient);
	await verifyEncryptionResetAddress(reset, create);
	reset.vaultId = 'another-vault';
	await expect(verifyEncryptionResetAddress(reset, create)).rejects.toThrow('does not identify');
});
