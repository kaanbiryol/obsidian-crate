import { describe, expect, it, vi } from 'vitest';
import { createHarness, runPeriodicCheck } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';
import { HttpError } from './api';
import { createSyncFailureResult } from './sync-result';
import { AUTH_ERROR_MESSAGE } from './engine-constants';

function fixture() {
	const h = createHarness({ lastSync: '2026-09-08T10:00:00.000Z', syncInterval: 0 });
	const states = vi.fn();
	h.engine.setStateChangeCallback(states);
	h.vault.getFiles.mockReturnValue([]);
	h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
	h.api.checkForChanges.mockResolvedValue({ hasChanges: false });
	return { ...h, states };
}

describe('periodic sync status', () => {
	it('shows a failed check instead of Synced and restores only its own error on recovery', async () => {
		const h = fixture();
		h.api.checkForChanges.mockRejectedValueOnce(new Error('network unavailable'));
		await runPeriodicCheck(h.engine);
		expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: 'Sync check failed: network unavailable', lastSync: h.settings.lastSync });
		await runPeriodicCheck(h.engine);
		expect(h.engine.getState()).toMatchObject({ status: 'idle', lastError: null, lastSync: '2026-09-08T10:00:00.000Z' });
		expect(h.settings.lastSync).toBe('2026-09-08T10:00:00.000Z');
		h.engine.destroy();
	});

	it('provides actionable authentication failure copy', async () => {
		const h = fixture();
		h.api.checkForChanges.mockRejectedValue(new HttpError('Unauthorized', 401));
		await runPeriodicCheck(h.engine);
		expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		h.engine.destroy();
	});

	it('does not clear a subsequent sync error after a successful no-change check', async () => {
		const h = fixture();
		h.api.checkForChanges.mockRejectedValueOnce(new Error('network unavailable'));
		await runPeriodicCheck(h.engine);
		h.api.getManifest.mockRejectedValueOnce(new Error('vault reconciliation failed'));
		await h.engine.sync();
		await runPeriodicCheck(h.engine);
		expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: 'vault reconciliation failed' });
		h.engine.destroy();
	});

	it('does not overlap timer checks or publish a late failure after destruction', async () => {
		const h = fixture();
		const gate = createDeferred<{ hasChanges: boolean }>();
		h.api.checkForChanges.mockReturnValue(gate.promise);
		const checking = runPeriodicCheck(h.engine);
		await runPeriodicCheck(h.engine);
		expect(h.api.checkForChanges).toHaveBeenCalledOnce();
		h.engine.destroy();
		gate.reject(new Error('late network failure'));
		await checking;
		expect(h.states).not.toHaveBeenCalled();
	});

	it('retains backoff for unsuccessful sync results instead of resetting it', async () => {
		const h = fixture();
		h.api.checkForChanges.mockResolvedValue({ hasChanges: true });
		vi.spyOn(h.engine, 'sync').mockResolvedValue(createSyncFailureResult('temporary upload failure'));
		await runPeriodicCheck(h.engine);
		h.engine.updateSettings({ ...h.settings, syncInterval: 3600 });
		await runPeriodicCheck(h.engine);
		await runPeriodicCheck(h.engine);
		expect(h.api.checkForChanges).toHaveBeenCalledTimes(2);
		h.engine.destroy();
	});

	it('does not turn a cancelled request into a connectivity failure', async () => {
		const h = fixture();
		h.api.checkForChanges.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
		await runPeriodicCheck(h.engine);
		expect(h.states).not.toHaveBeenCalled();
		h.engine.destroy();
	});
});
