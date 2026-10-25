import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedReminderSnapshots, loadCachedReminderSnapshot, saveCachedReminderSnapshot } from './reminder-cache';
import type { ReminderRecord } from '../types';
import { AUTH_TOKEN_KEY } from '../../config';
import { prepareReminderEncryption, resetReminderEncryption } from '../encryption-session';
import { unlockPrivateStorage } from '../private-storage';
import { LocalStateCipher } from '../../../encryption/local-state';

// In-memory stores keyed like the real database; null uses the real opener.
const memory = vi.hoisted(() => ({ stores: null as Map<string, Map<string, unknown>> | null }));
vi.mock('./reminder-cache-database', async importOriginal => {
	const actual = await importOriginal<typeof import('./reminder-cache-database')>();
	type Range = { lower: [string] };
	const isRange = (key: unknown): key is Range => typeof key === 'object' && key !== null && 'lower' in key;
	const recordKey = (value: { folderPath: string; path?: string }) => JSON.stringify(value.path === undefined ? value.folderPath : [value.folderPath, value.path]);
	const objectStore = (name: string) => {
		const store = memory.stores!.get(name) ?? new Map<string, unknown>();
		memory.stores!.set(name, store);
		const matching = (range: Range) => [...store.keys()].filter(key => (JSON.parse(key) as unknown[])[0] === range.lower[0]);
		return {
			get: async (key: unknown) => store.get(JSON.stringify(key)),
			getAll: async (range: Range) => matching(range).map(key => store.get(key)),
			put: async (value: { folderPath: string; path?: string }) => { store.set(recordKey(value), structuredClone(value)); },
			delete: async (key: unknown) => { for (const stored of isRange(key) ? matching(key) : [JSON.stringify(key)]) store.delete(stored); },
		};
	};
	const database = () => ({
		transaction: () => ({ objectStore, done: Promise.resolve(), abort: () => {} }),
		put: (name: string, value: { folderPath: string }) => objectStore(name).put(value),
		close: () => {},
	});
	return { ...actual, openCacheDatabase: async () => memory.stores ? database() : actual.openCacheDatabase() };
});

const reminder: ReminderRecord = {
	id: 'r1',
	content: 'Cached task',
	priority: 4,
	completed: false,
	project: 'Inbox',
	filePath: 'Reminders/Inbox.md',
};

describe('PWA reminder cache', () => {
	beforeEach(() => {
		vi.stubGlobal('indexedDB', undefined);
	});

	afterEach(() => vi.unstubAllGlobals());

	it('treats unavailable IndexedDB as an empty best-effort cache', async () => {
		await saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 1234, etag: '"revision"' });

		await expect(loadCachedReminderSnapshot('Reminders')).resolves.toBeNull();
	});

	it('reports that an unavailable cache could not be cleared', async () => {
		await expect(clearCachedReminderSnapshots()).resolves.toBe(false);
	});
});

describe('PWA reminder cache encryption lock', () => {
	beforeEach(() => {
		memory.stores = new Map();
		const values = new Map<string, string>([[AUTH_TOKEN_KEY, 'session']]);
		vi.stubGlobal('localStorage', {
			get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
			getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
			removeItem: (key: string) => { values.delete(key); },
		});
		vi.stubGlobal('navigator', { onLine: true });
		vi.stubGlobal('IDBKeyRange', { bound: (lower: unknown, upper: unknown) => ({ lower, upper }) });
		resetReminderEncryption(true);
	});
	afterEach(() => { memory.stores = null; resetReminderEncryption(true); vi.unstubAllGlobals(); });

	it('keeps an unencrypted offline copy when the encryption check is unavailable', async () => {
		await prepareReminderEncryption('session', async () => Response.json({ encryption: null }));
		await saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 1234, etag: '"revision"' });
		await expect(prepareReminderEncryption('session', async () => Response.json({}, { status: 503 }), true)).rejects.toThrow('Could not verify encryption');

		await expect(loadCachedReminderSnapshot('Reminders')).resolves.toMatchObject({ reminders: [reminder], etag: '"revision"' });
		// Only an unlocked cipher retires the plaintext copy.
		unlockPrivateStorage(new LocalStateCipher('vault', 'scope', crypto.getRandomValues(new Uint8Array(32))), 'Reminders', localStorage, localStorage);
		await expect(loadCachedReminderSnapshot('Reminders')).resolves.toBeNull();
		expect(memory.stores?.get('notes')?.size).toBe(0);
	});
});
