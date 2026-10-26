import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { rememberPairedBundle, rememberRecoveryKey } from './web-app-unlock';
import { createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { rememberVaultKeys } from './encryption-keys';
import { AUTH_TOKEN_KEY, saveConfig } from '../config';
import { READING_SESSION_KEY } from '../reading/session/session';
vi.mock('./encryption-keys', () => ({ rememberVaultKeys: vi.fn(async () => {}) }));

beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
	vi.mocked(rememberVaultKeys).mockClear();
	localStorage.setItem(AUTH_TOKEN_KEY, 'reminders-session');
	saveConfig({ folderPath: 'Old reminders', upcomingDays: 7, allDayNotificationTime: null });
	localStorage.setItem(READING_SESSION_KEY, JSON.stringify({ token: 'reading-token', id: 'reading-session', folderPath: 'Old reading', generation: 'policy', expiresAt: Date.now() + 100000 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture() {
	const code = await generateRecoveryCode();
	const bundle = await createVaultKeyBundle();
	const expected: EncryptionServerState = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, code)), mode: 'active' };
	return { bundle, expected, code };
}
it('stores the recovered vault keys once for every feature', async () => {
	const f = await fixture();
	await rememberRecoveryKey(f.code, f.expected, () => true);
	expect(rememberVaultKeys).toHaveBeenCalledExactlyOnceWith(f.bundle, expect.any(Function));
});
it('rejects another vault before persisting any keys', async () => {
	const f = await fixture(); f.expected.vaultId = crypto.randomUUID();
	await expect(rememberRecoveryKey(f.code, f.expected, () => true)).rejects.toThrow('does not match');
	expect(rememberVaultKeys).not.toHaveBeenCalled();
});
it.each(['reminders', 'reading', 'caller'])('stops a stale import when the %s session changes', async feature => {
	const f = await fixture(); let active = true;
	vi.mocked(rememberVaultKeys).mockImplementationOnce(async (_bundle, current) => {
		if (feature === 'reminders') localStorage.setItem(AUTH_TOKEN_KEY, 'new-session');
		if (feature === 'reading') localStorage.removeItem(READING_SESSION_KEY);
		if (feature === 'caller') active = false;
		expect(current!()).toBe(false);
		throw new Error('Session changed');
	});
	await expect(rememberRecoveryKey(f.code, f.expected, () => active)).rejects.toThrow('Session changed');
	expect(rememberVaultKeys).toHaveBeenCalledOnce();
});
it('supports an enrollment for one feature without depending on sibling session data', async () => {
	const f = await fixture(); localStorage.setItem(READING_SESSION_KEY, 'damaged');
	await rememberRecoveryKey(f.code, f.expected, () => true);
	expect(rememberVaultKeys).toHaveBeenCalledOnce();
});

it.each(['wrong key', 'tampered bundle', 'generation', 'data key', 'notification key', 'seal key', 'resetting'] as const)('rejects %s before persisting keys', async change => {
	const f = await fixture();
	if (change === 'wrong key') f.code = await generateRecoveryCode();
	if (change === 'tampered bundle') f.expected.recovery.envelope += 'a';
	if (change === 'generation') f.expected.generation++;
	if (change === 'data key') f.expected.keyId = crypto.randomUUID();
	if (change === 'notification key') f.expected.notificationKeyId = crypto.randomUUID();
	if (change === 'seal key') f.expected.seal.keyId = crypto.randomUUID();
	if (change === 'resetting') f.expected.mode = change;
	await expect(rememberRecoveryKey(f.code, f.expected, () => true)).rejects.toThrow();
	expect(rememberVaultKeys).not.toHaveBeenCalled();
});

it('accepts the saved recovery code with surrounding whitespace', async () => {
	const f = await fixture();
	await rememberRecoveryKey(` ${f.code}\n`, f.expected, () => true);
	expect(rememberVaultKeys).toHaveBeenCalledOnce();
});

it('imports an approved paired bundle', async () => {
	const f = await fixture();
	await rememberPairedBundle({ bundle: f.bundle }, f.expected, () => true);
	expect(rememberVaultKeys).toHaveBeenCalledExactlyOnceWith(f.bundle, expect.any(Function));
});
it.each(['damaged secret', 'vault', 'generation', 'data key', 'missing bundle', 'extra field', 'resetting', 'stale session'] as const)('rejects a pairing transfer with %s before storing keys', async problem => {
	const f = await fixture();
	const packet: { bundle?: typeof f.bundle; vault?: unknown } = { bundle: f.bundle };
	if (problem === 'damaged secret') f.bundle.vault.secret = 'short';
	if (problem === 'vault') f.bundle.vaultId = crypto.randomUUID();
	if (problem === 'generation') f.bundle.generation++;
	if (problem === 'data key') f.bundle.vault.id = crypto.randomUUID();
	if (problem === 'missing bundle') delete packet.bundle;
	if (problem === 'extra field') packet.vault = f.bundle.vault;
	if (problem === 'resetting') f.expected.mode = 'resetting';
	await expect(rememberPairedBundle(packet, f.expected, () => problem !== 'stale session')).rejects.toThrow();
	expect(rememberVaultKeys).not.toHaveBeenCalled();
});
it('stops a pairing import if the connection changes while keys are stored', async () => {
	const f = await fixture();
	vi.mocked(rememberVaultKeys).mockImplementationOnce(async () => { localStorage.removeItem(READING_SESSION_KEY); return undefined as never; });
	await expect(rememberPairedBundle({ bundle: f.bundle }, f.expected, () => true)).rejects.toThrow('connection changed');
	expect(rememberVaultKeys).toHaveBeenCalledOnce();
});
