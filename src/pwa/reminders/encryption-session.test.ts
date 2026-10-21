import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { consumeReminderEncryptionFragment, reminderEncryptionSnapshot, prepareReminderEncryption, resetReminderEncryption } from './encryption-session';
import { invalidatePwaSession } from '../session-generation';
import { AUTH_TOKEN_KEY } from '../config';
import { LocalStateCipher } from '../../encryption/local-state';
import { unlockPrivateStorage, privateStorageEnabled, sealPrivateValue, openPrivateValue } from './private-storage';
import { createReminderOutboxStorage } from './outbox/reminder-outbox-storage';
import { getPwaPushManager } from '../service-worker-registration';

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
	resetReminderEncryption(true);
});
afterEach(() => { invalidatePwaSession(); resetReminderEncryption(true); vi.unstubAllGlobals(); });

it('keeps the confirmed push provider during a same-session encryption recheck', async () => {
	expect(reminderEncryptionSnapshot().status).toBe('checking');
	await prepareReminderEncryption('session', async () => Response.json({ encryption: null }));
	let finish!: (response: Response) => void;
	const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
	const refreshing = prepareReminderEncryption('session', fetch);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
	expect(reminderEncryptionSnapshot().status).toBe('unencrypted');
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
	const pending = prepareReminderEncryption('session', fetch);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
	invalidatePwaSession(); resetReminderEncryption();
	finish(Response.json({ encryption: null }));
	await expect(pending).rejects.toThrow('Connection changed');
	expect(reminderEncryptionSnapshot().status).toBe('checking');
	expect(() => sealPrivateValue('must remain locked', 'test')).toThrow('Unlock');
});

it('restores durable writes when an open encrypted tab adopts a verified unencrypted session', async () => {
	unlockPreviousSession();
	const retainedKey = 'retained-ciphertext';
	const retained = sealPrivateValue('preserve for recovery', retainedKey);
	// The peer's logout clears shared state; this tab locks its in-memory key.
	localStorage.clear(); invalidatePwaSession(); resetReminderEncryption(true);
	localStorage.setItem(AUTH_TOKEN_KEY, 'new-session');
	invalidatePwaSession(); resetReminderEncryption();
	localStorage.setItem(retainedKey, retained);
	expect(() => sealPrivateValue('before confirmation', 'test')).toThrow('Unlock');
	await prepareReminderEncryption('new-session', async () => Response.json({ encryption: null }));
	expect(reminderEncryptionSnapshot().status).toBe('unencrypted');
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

it.each([[200, 'no longer reports'], [404, 'Could not verify encryption']] as const)('keeps a previous encrypted enrollment locked when a %s response omits encryption', async (status, message) => {
	unlockPreviousSession(); resetReminderEncryption();
	localStorage.setItem('crate-encryption-session:previous-session', 'encrypted enrollment');
	await expect(prepareReminderEncryption('session', async () => Response.json({ encryption: null }, { status })))
		.rejects.toThrow(message);
	expect(reminderEncryptionSnapshot().status).toBe('locked');
	expect(() => sealPrivateValue('must remain locked', 'test')).toThrow('Unlock');
});

it.each([200, 404])('rejects plaintext mode for a fresh encrypted setup link when the server returns %s', async status => {
  vi.stubGlobal('window', { location: { hash: '#crateKey=private-setup-key', pathname: '/notifications', search: '' }, history: { state: null, replaceState: vi.fn() } });
  consumeReminderEncryptionFragment();
  await expect(prepareReminderEncryption('session', async () => Response.json({ encryption: null }, { status }))).rejects.toThrow();
  expect(reminderEncryptionSnapshot().status).toBe('locked');
  expect(() => sealPrivateValue('private draft', 'test')).toThrow('Unlock');
});

it('keeps storage locked after an unavailable check and permits writes after a successful plaintext retry', async () => {
	await expect(prepareReminderEncryption('session', async () => Response.json({}, { status: 503 }))).rejects.toThrow('Could not verify encryption');
	expect(() => sealPrivateValue('must remain locked', 'test')).toThrow('Unlock');
	await prepareReminderEncryption('session', async () => Response.json({ encryption: null }));
	expect(sealPrivateValue('new draft', 'draft')).toBe('new draft');
});
