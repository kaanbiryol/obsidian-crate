import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { consumeEncryptionFragment, encryptionSnapshot, preparePwaEncryption, resetPwaEncryption } from './encryption-session';
import { invalidatePwaSession } from './session-generation';
import { AUTH_TOKEN_KEY } from './config';
import { getPwaPushManager } from './api';
import { LocalStateCipher } from '../encryption/local-state';
import { unlockPrivateStorage, privateStorageEnabled, sealPrivateValue, openPrivateValue } from './private-storage';
import { createReminderOutboxStorage } from './reminder-outbox-storage';

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

function unlockPreviousSession() {
	unlockPrivateStorage(new LocalStateCipher('vault', 'scope', crypto.getRandomValues(new Uint8Array(32))),
		'Reminders', localStorage, sessionStorage);
}

beforeEach(() => {
	vi.stubGlobal('localStorage', storage());
	vi.stubGlobal('sessionStorage', storage());
	vi.stubGlobal('navigator', { onLine: true });
	localStorage.setItem(AUTH_TOKEN_KEY, 'session');
	resetPwaEncryption(true);
});
afterEach(() => { invalidatePwaSession(); resetPwaEncryption(true); vi.unstubAllGlobals(); });

it('keeps the confirmed push provider during a same-session encryption recheck', async () => {
	expect(encryptionSnapshot().status).toBe('checking');
	await preparePwaEncryption('session', async () => Response.json({ encryption: null }));
	let finish!: (response: Response) => void;
	const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
	const refreshing = preparePwaEncryption('session', fetch);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
	expect(encryptionSnapshot().status).toBe('legacy');
	const windowPushManager = {} as PushManager;
	const registerServiceWorker = vi.fn(async () => null);
	await expect(getPwaPushManager({ windowPushManager, registerServiceWorker })).resolves.toBe(windowPushManager);
	expect(registerServiceWorker).not.toHaveBeenCalled();
	finish(Response.json({ encryption: null })); await refreshing;
});

it('clears the status on session reset and ignores an older response', async () => {
	unlockPreviousSession();
	let finish!: (response: Response) => void;
	const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
	const pending = preparePwaEncryption('session', fetch);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
	invalidatePwaSession(); resetPwaEncryption();
	finish(Response.json({ encryption: null }));
	await expect(pending).rejects.toThrow('Connection changed');
	expect(encryptionSnapshot().status).toBe('checking');
	expect(() => sealPrivateValue('must remain locked', 'test')).toThrow('Unlock');
});

it('restores durable writes when an open encrypted tab adopts a verified unencrypted session', async () => {
	unlockPreviousSession();
	const retainedKey = 'retained-ciphertext';
	const retained = sealPrivateValue('preserve for recovery', retainedKey);
	// The peer's logout clears shared state; this tab locks its in-memory key.
	localStorage.clear(); invalidatePwaSession(); resetPwaEncryption(true);
	localStorage.setItem(AUTH_TOKEN_KEY, 'new-session');
	invalidatePwaSession(); resetPwaEncryption();
	localStorage.setItem(retainedKey, retained);
	expect(() => sealPrivateValue('before confirmation', 'test')).toThrow('Unlock');
	await preparePwaEncryption('new-session', async () => Response.json({ encryption: null }));
	expect(encryptionSnapshot().status).toBe('legacy');
	expect(privateStorageEnabled()).toBe(false);
	const outbox = await createReminderOutboxStorage('new-session', 'Reminders');
	const operationId = crypto.randomUUID();
	const change = { operationId, kind: 'complete' as const, recordId: 'reminder', status: 'pending' as const,
		path: '/reminders/set-completed' as const, method: 'POST' as const, attempts: 0, retryAt: 0,
		body: JSON.stringify({ operationId, folderPath: 'Reminders', id: 'reminder', completed: true }) };
	outbox.put(change);
	expect(outbox.load()).toEqual([change]);
	expect(sealPrivateValue('new draft', 'draft')).toBe('new draft');
	expect(localStorage.getItem(retainedKey)).toBe(retained);
	expect(() => openPrivateValue(retained, retainedKey)).toThrow('Unlock');
});

it.each([200, 404])('keeps a previous encrypted enrollment locked when a %s response omits encryption', async status => {
	unlockPreviousSession(); resetPwaEncryption();
	localStorage.setItem('crate-encryption-session:previous-session', 'encrypted enrollment');
	await expect(preparePwaEncryption('session', async () => Response.json({ encryption: null }, { status })))
		.rejects.toThrow('no longer reports');
	expect(encryptionSnapshot().status).toBe('locked');
	expect(() => sealPrivateValue('must remain locked', 'test')).toThrow('Unlock');
});

it.each([200, 404])('rejects plaintext mode for a fresh encrypted setup link when the server returns %s', async status => {
  vi.stubGlobal('window', { location: { hash: '#crateKey=private-setup-key', pathname: '/notifications', search: '' }, history: { state: null, replaceState: vi.fn() } });
  consumeEncryptionFragment();
  await expect(preparePwaEncryption('session', async () => Response.json({ encryption: null }, { status }))).rejects.toThrow();
  expect(encryptionSnapshot().status).toBe('locked');
  expect(() => sealPrivateValue('private draft', 'test')).toThrow('Unlock');
});

it('keeps storage locked after an unavailable check and permits writes after a successful plaintext retry', async () => {
	await expect(preparePwaEncryption('session', async () => Response.json({}, { status: 503 }))).rejects.toThrow('Could not verify encryption');
	expect(() => sealPrivateValue('must remain locked', 'test')).toThrow('Unlock');
	await preparePwaEncryption('session', async () => Response.json({ encryption: null }));
	expect(sealPrivateValue('new draft', 'draft')).toBe('new draft');
});
