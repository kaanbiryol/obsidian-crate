import { describe, expect, it, vi } from 'vitest';
import { abortTransaction } from './abort-transaction';

describe('abortTransaction', () => {
	it('aborts and waits for the rejected transaction to settle', async () => {
		const tx = { abort: vi.fn(), done: Promise.reject(new DOMException('Aborted', 'AbortError')) };
		await expect(abortTransaction(tx)).resolves.toBeUndefined();
		expect(tx.abort).toHaveBeenCalledOnce();
	});

	it('ignores a transaction that already finished', async () => {
		const tx = { abort: () => { throw new DOMException('Finished', 'InvalidStateError'); }, done: Promise.resolve() };
		await expect(abortTransaction(tx)).resolves.toBeUndefined();
	});
});
