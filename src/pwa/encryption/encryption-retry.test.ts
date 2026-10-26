import { expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('../shared-features', () => ({ requestSharedFeaturesRefresh: refresh }));
import { checkEncryptionSignals, EncryptionStateChangedError, retryAfterEncryptionChange } from './encryption-retry';

it('retries once with refreshed keys after the vault encryption changes', async () => {
	const run = vi.fn(async (refreshKeys: boolean) => {
		if (!refreshKeys) throw new EncryptionStateChangedError('changed');
		return 'ok';
	});
	await expect(retryAfterEncryptionChange(run)).resolves.toBe('ok');
	expect(run.mock.calls).toEqual([[false], [true]]);
});

it('does not retry other failures or a second encryption change', async () => {
	const failure = new Error('offline');
	await expect(retryAfterEncryptionChange(vi.fn(async () => { throw failure; }))).rejects.toBe(failure);
	const changed = vi.fn(async () => { throw new EncryptionStateChangedError('changed'); });
	await expect(retryAfterEncryptionChange(changed)).rejects.toBeInstanceOf(EncryptionStateChangedError);
	expect(changed).toHaveBeenCalledTimes(2);
});

it('treats a 428 as an encryption change except from the feature’s own probe', () => {
	const options = { probePath: '/encryption', message: 'The vault encryption changed.' };
	expect(() => checkEncryptionSignals(new Response(null, { status: 428 }), '/reminders/list', options)).toThrow(EncryptionStateChangedError);
	expect(() => checkEncryptionSignals(new Response(null, { status: 428 }), '/encryption', options)).not.toThrow();
	expect(() => checkEncryptionSignals(new Response(null, { status: 428 }), '/reminders/list', { ...options, encrypted: false })).not.toThrow();
});

it('refreshes shared features after a 423', () => {
	refresh.mockClear();
	checkEncryptionSignals(new Response(null, { status: 423 }), '/reading/list', { probePath: '/reading/encryption', message: '' });
	expect(refresh).toHaveBeenCalledWith(true);
});
