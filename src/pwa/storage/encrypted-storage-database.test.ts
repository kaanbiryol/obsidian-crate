import { afterEach, expect, it, vi } from 'vitest';
import type { DBSchema } from 'idb';
import { openEncryptedDatabase } from './encrypted-storage-database';

interface TestDatabase extends DBSchema { keys: { key: string; value: string } }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['timeout', 'blocked'])('fences late database success and upgrades after %s', async reason => {
	vi.useFakeTimers();
	const database = { close: vi.fn(), createObjectStore: vi.fn() };
	const transaction = { abort: vi.fn() };
	const request = { result: database, transaction: null } as unknown as IDBOpenDBRequest;
	vi.stubGlobal('indexedDB', { open: () => request });
	const opened = openEncryptedDatabase<TestDatabase>('private', 'keys');
	const rejected = expect(opened).rejects.toThrow('Close other Crate tabs and retry');
	if (reason === 'timeout') await vi.advanceTimersByTimeAsync(3000);
	else request.onblocked?.call(request, {} as IDBVersionChangeEvent);
	await rejected;
	Object.defineProperty(request, 'transaction', { value: transaction });
	request.onupgradeneeded?.call(request, { oldVersion: 0 } as IDBVersionChangeEvent);
	expect(transaction.abort).toHaveBeenCalledOnce();
	expect(database.createObjectStore).not.toHaveBeenCalled();
	request.onsuccess?.call(request, {} as Event);
	expect(database.close).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it('aborts an upgrade that is still pending when the open deadline expires', async () => {
	vi.useFakeTimers();
	const abort = vi.fn();
	const request = { result: { createObjectStore: vi.fn() }, transaction: { abort } } as unknown as IDBOpenDBRequest;
	vi.stubGlobal('indexedDB', { open: () => request });
	const rejected = expect(openEncryptedDatabase<TestDatabase>('private', 'keys')).rejects.toThrow('Close other Crate tabs and retry');
	request.onupgradeneeded?.call(request, { oldVersion: 0 } as IDBVersionChangeEvent);
	await vi.advanceTimersByTimeAsync(3000);
	await rejected;
	expect(abort).toHaveBeenCalledOnce();
});

it('reports synchronous denied storage without leaking a deadline timer', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Denied', 'SecurityError'); } });
	await expect(openEncryptedDatabase<TestDatabase>('private', 'keys')).rejects.toThrow('Check browser storage permissions');
	expect(vi.getTimerCount()).toBe(0);
});
