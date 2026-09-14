import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudflareApiError } from './cloudflare-api';
import { deleteObjectGroup } from './reset-delete-pool';

beforeEach(() => vi.stubGlobal('window', globalThis));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('fills freed slots without waiting for the slowest file', async () => {
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	const deleted = vi.fn();
	const remove = vi.fn(async (key: string) => { if (key === '0') await pending; });
	const operation = deleteObjectGroup(Array.from({ length: 100 }, (_, i) => String(i)), remove, deleted, vi.fn());
	await vi.waitFor(() => expect(deleted).toHaveBeenCalledTimes(99));
	expect(remove).toHaveBeenCalledTimes(100);
	release();
	await operation;
	expect(deleted).toHaveBeenCalledTimes(100);
});

it('backs off explicit throttling and counts only successful deletions', async () => {
	vi.useFakeTimers();
	const remove = vi.fn().mockRejectedValueOnce(new CloudflareApiError('Throttled', 429, null)).mockResolvedValue(undefined);
	const deleted = vi.fn();
	const throttled = vi.fn();
	const operation = deleteObjectGroup(['file'], remove, deleted, throttled);
	await vi.advanceTimersByTimeAsync(999);
	expect(remove).toHaveBeenCalledTimes(1);
	expect(deleted).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await operation;
	expect(remove).toHaveBeenCalledTimes(2);
	expect(deleted).toHaveBeenCalledOnce();
	expect(throttled).toHaveBeenCalledOnce();
});

it('stops after three rate-limit retries', async () => {
	vi.useFakeTimers();
	const remove = vi.fn().mockRejectedValue(new CloudflareApiError('Throttled', 429, null));
	const operation = deleteObjectGroup(['file'], remove, vi.fn(), vi.fn());
	const rejected = expect(operation).rejects.toThrow('Throttled');
	await vi.runAllTimersAsync();
	await rejected;
	expect(remove).toHaveBeenCalledTimes(4);
});

it('does not retry network failures or lose uncertainty behind a rate-limit error', async () => {
	const remove = vi.fn(async (key: string) => {
		if (key === 'network') throw new Error('offline');
		throw new CloudflareApiError('Throttled', 429, null);
	});
	await expect(deleteObjectGroup(['network', 'limited'], remove, vi.fn(), vi.fn())).rejects.toThrow('offline');
	expect(remove).toHaveBeenCalledTimes(2);
});
