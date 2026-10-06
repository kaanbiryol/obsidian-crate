import { describe, expect, it } from 'vitest';
import { cancelSyncResult, createEmptySyncResult, createSyncFailureResult, finalizeSyncResult, mergeSyncResults } from './sync-result';

describe('sync outcome aggregation', () => {
	it('retains cancellation when merging completed work and finalizing again', () => {
		const result = cancelSyncResult(createEmptySyncResult());
		const completed = { ...createEmptySyncResult(), uploaded: 1, uploadedPaths: ['saved.md'] };
		mergeSyncResults(result, completed);
		expect(finalizeSyncResult(result)).toBe(false);
		expect(result).toMatchObject({ outcome: 'cancelled', success: false, uploaded: 1, uploadedPaths: ['saved.md'], errors: [] });
	});

	it('propagates cancellation from a reconciliation result without losing earlier errors', () => {
		const result = createSyncFailureResult('earlier.md: unreadable');
		mergeSyncResults(result, cancelSyncResult({ ...createEmptySyncResult(), deleted: 1, deletedPaths: ['removed.md'] }));
		expect(result).toMatchObject({ outcome: 'cancelled', success: false, deleted: 1, errors: ['earlier.md: unreadable'] });
	});

	it('does not turn an explicit failure with no message into success', () => {
		const result = { ...createEmptySyncResult(), success: false };
		expect(finalizeSyncResult(result)).toBe(false);
		expect(finalizeSyncResult(result)).toBe(false);
		expect(result.outcome).toBe('failed');
	});
});
