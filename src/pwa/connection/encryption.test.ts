import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { createEncryptionState } from '../../encryption/server-state';
import { onConnectionExpired } from './expiration';
import { EncryptionVerificationUnavailableError, loadEncryptionState } from './encryption';

function storage(): Storage {
	const values: Record<string, string> = {};
	return Object.defineProperties(values, {
		length: { get: () => Object.keys(values).length },
		key: { value: (index: number) => Object.keys(values)[index] ?? null },
		getItem: { value: (key: string) => values[key] ?? null },
		setItem: { value: (key: string, value: string) => { values[key] = value; } },
		removeItem: { value: (key: string) => { delete values[key]; } },
		clear: { value: () => { for (const key of Object.keys(values)) delete values[key]; } },
	}) as unknown as Storage;
}

async function encryptionState() {
	const bundle = await createVaultKeyBundle();
	return { ...createEncryptionState(bundle, { version: 1, vaultId: bundle.vaultId, envelope: 'a.b.c.d.e' }), mode: 'active' as const };
}

const load = (request: () => Promise<Response>, current = () => true) =>
	loadEncryptionState({ token: 'token', purpose: 'reminders', request, current });

beforeEach(() => {
	vi.stubGlobal('localStorage', storage());
	vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('encryption verification', () => {
	it('remembers verified encryption and uses it while offline', async () => {
		const state = await encryptionState();
		expect(await load(async () => Response.json({ encryption: state }))).toEqual(state);
		vi.stubGlobal('navigator', { onLine: false });
		expect(await load(async () => { throw new TypeError('offline'); })).toEqual(state);
	});

	it('refuses a server that stops reporting known encryption', async () => {
		await load(async () => Response.json({ encryption: await encryptionState() }));
		await expect(load(async () => Response.json({ encryption: null }))).rejects.toThrow('no longer reports');
	});

	it('does not treat a missing encryption endpoint as an unencrypted vault', async () => {
		await expect(load(async () => new Response(null, { status: 404 }))).rejects.toThrow('Could not verify encryption');
	});

	it('reports an expired connection and an unreachable server separately', async () => {
		const expired = vi.fn();
		const stop = onConnectionExpired(expired);
		await expect(load(async () => new Response(null, { status: 401 }))).rejects.toThrow('Could not verify encryption');
		stop();
		expect(expired).toHaveBeenCalledWith('token');
		await expect(load(async () => { throw new TypeError('network'); })).rejects.toBeInstanceOf(EncryptionVerificationUnavailableError);
	});

	it('requires one online verification for an encrypted session link', async () => {
		vi.stubGlobal('navigator', { onLine: false });
		await expect(loadEncryptionState({ token: 'token', purpose: 'reminders', fragment: 'e2ee', request: async () => { throw new TypeError('offline'); }, current: () => true }))
			.rejects.toThrow('Go online once');
	});

	it('does not remember a state for a connection that changed meanwhile', async () => {
		await expect(load(async () => Response.json({ encryption: await encryptionState() }), () => false)).rejects.toThrow('Connection changed');
		expect(localStorage.length).toBe(0);
	});
});
