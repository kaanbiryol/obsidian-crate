import { afterEach, expect, it, vi } from 'vitest';
import type CratePlugin from './CratePlugin';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { openDeviceKeyRequest, openWebAppPairing } from './web-app-pairing';
import { PAIRING_CAPABILITY, type PairingContext } from '../encryption/pairing/protocol';
import { SECRET_KEYS } from '../platform/secret-keys';

const mocks = vi.hoisted(() => ({
	info: vi.fn(async () => ({ capabilities: ['web-pairing-v1'] })),
	request: vi.fn(async () => ({})),
	state: vi.fn(),
	unlock: vi.fn(async () => {}),
	pairing: vi.fn(async () => ({})),
}));
vi.mock('./encryption-setup', () => ({ unlockVaultWithPairedKeys: mocks.unlock }));
vi.mock('../encryption/pairing/session', () => ({ requestAppPairing: mocks.pairing }));
vi.mock('../sync/worker-api/http', () => ({ obsidianHttpTransport: vi.fn(), WorkerApiHttpClient: class {
	setAbortSignal() {} setEncryptionAuthority() {}
	getServerInfo = mocks.info;
	requestJson = mocks.request;
} }));
vi.mock('../sync/encryption/server-encryption', async () => ({ ...await vi.importActual('../sync/encryption/server-encryption'), readServerEncryption: mocks.state }));
afterEach(() => { vi.clearAllMocks(); mocks.info.mockResolvedValue({ capabilities: [PAIRING_CAPABILITY] }); });
async function fixture() {
	const bundle = await createVaultKeyBundle();
	const state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' as const };
	mocks.state.mockResolvedValue(state);
	const values = new Map<string, string>([[SECRET_KEYS.AUTH_TOKEN, 'vault-token'], [SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle)]]);
	const plugin = { settings: { workerUrl: 'https://server.test', reading: { folderPath: 'Reading' } }, remindersSettings: { remindersFolderPath: 'Reminders' },
		secretStorage: { get: (key: string) => values.get(key) ?? null } } as CratePlugin;
	const context: PairingContext = { version: 1, origin: plugin.settings.workerUrl, id: crypto.randomUUID(), vaultId: bundle.vaultId, generation: bundle.generation };
	const controller = new AbortController();
	return { bundle, state, plugin, values, context, controller };
}
it('releases the unlocked vault keys only after confirming the active server state', async () => {
	const f = await fixture();
	const session = await openWebAppPairing(f.plugin, f.controller.signal);
	expect(mocks.state).not.toHaveBeenCalled();
	await session.transport.read(); await session.transport.read();
	expect(mocks.state).not.toHaveBeenCalled();
	const payload = await session.payload(f.context);
	expect(mocks.state).toHaveBeenCalledOnce();
	expect(payload).toEqual({ bundle: f.bundle });
});
it.each(['locked', 'changed token', 'changed keys', 'closed', 'wrong origin', 'new generation', 'resetting'] as const)('refuses key release for %s', async problem => {
	const f = await fixture();
	if (problem === 'locked') f.values.delete(SECRET_KEYS.ENCRYPTION_KEYS);
	const work = async () => {
		const session = await openWebAppPairing(f.plugin, f.controller.signal);
		if (problem === 'changed token') f.values.set(SECRET_KEYS.AUTH_TOKEN, 'other');
		if (problem === 'changed keys') f.values.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(await createVaultKeyBundle()));
		if (problem === 'closed') f.controller.abort();
		if (problem === 'wrong origin') f.context.origin = 'https://another.test';
		if (problem === 'new generation') mocks.state.mockResolvedValue({...f.state,generation:f.state.generation+1});
		if (problem === 'resetting') mocks.state.mockResolvedValue({...f.state,mode:'resetting'});
		await session.payload(f.context);
	};
	await expect(work()).rejects.toThrow();
});
it('fences a pending approval when the modal closes during its state read', async () => {
	const f = await fixture();
	const session = await openWebAppPairing(f.plugin, f.controller.signal);
	mocks.state.mockImplementationOnce(async () => { f.controller.abort(); return f.state; });
	await expect(session.payload(f.context)).rejects.toThrow();
	// Closing the UI can still cancel an accepted relay record.
	await session.cancel(f.context.id);
	expect(mocks.request).toHaveBeenCalledWith('/encryption/pairing', expect.objectContaining({ method: 'POST' }), 5000);
});

it('unlocks with requested keys only while the vault is unchanged', async () => {
	const f = await fixture();
	const request = openDeviceKeyRequest(f.plugin, f.controller.signal);
	await expect(request.unlock({ bundle: f.bundle })).rejects.toThrow('The vault changed');
	await request.start();
	expect(mocks.pairing).toHaveBeenCalledWith(expect.objectContaining({ vaultId: f.state.vaultId, generation: f.state.generation, origin: 'https://server.test' }), expect.anything(), expect.any(Function));
	await request.unlock({ bundle: f.bundle });
	expect(mocks.unlock).toHaveBeenCalledWith(f.plugin, f.state, f.bundle, expect.any(Function));
	mocks.state.mockResolvedValue({ ...f.state, generation: f.state.generation + 1 });
	await expect(request.unlock({ bundle: f.bundle })).rejects.toThrow('The vault changed');
	expect(mocks.unlock).toHaveBeenCalledOnce();
});

it.each([['extra fields', (bundle: unknown) => ({ bundle, note: 'x' })], ['an invalid bundle', () => ({ bundle: { vaultId: 'x' } })]])('refuses a key transfer with %s', async (_name, packet) => {
	const f = await fixture();
	const request = openDeviceKeyRequest(f.plugin, f.controller.signal);
	await request.start();
	await expect(request.unlock(packet(f.bundle))).rejects.toThrow('Invalid key transfer.');
	expect(mocks.unlock).not.toHaveBeenCalled();
});

it('requests keys only from an encrypted vault', async () => {
	const f = await fixture();
	mocks.state.mockResolvedValue({ ...f.state, mode: 'resetting' });
	await expect(openDeviceKeyRequest(f.plugin, f.controller.signal).start()).rejects.toThrow('This vault is not encrypted');
	expect(mocks.pairing).not.toHaveBeenCalled();
});
