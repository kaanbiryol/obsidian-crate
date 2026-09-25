import { describe, expect, it } from 'vitest';
import { createHarness, runPeriodicCheck } from './engine-test-harness';
import { recordSyncHistory } from './runtime-history';
import { createEmptySyncResult, createSyncFailureResult } from './sync-result';
import { AUTH_ERROR_MESSAGE } from './engine-constants';

const lastSync = '2026-09-23T11:54:44.763Z';

function savedFailure() {
	const h = createHarness({ lastSync });
	recordSyncHistory(h.settings, 'sync', createSyncFailureResult(AUTH_ERROR_MESSAGE));
	h.engine.destroy();
	return h.settings;
}

describe('sync status after restart', () => {
	it('restores the failed attempt instead of displaying the older success', async () => {
		const h = createHarness(savedFailure());
		expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE, lastSync });
		h.vault.getFiles.mockReturnValue([]);
		h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		h.api.checkForChanges.mockResolvedValue({ hasChanges: false });
		h.api.getManifest.mockResolvedValue({ version: 1, files: {} });
		await runPeriodicCheck(h.engine);
		expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		const result = await h.engine.sync();
		expect(result.success).toBe(true);
		expect(h.engine.getState()).toMatchObject({ status: 'idle', lastError: null });
		recordSyncHistory(h.settings, 'sync', result);
		h.engine.destroy();
		const restarted = createHarness(h.settings);
		expect(restarted.engine.getState()).toMatchObject({ status: 'idle', lastError: null });
		restarted.engine.destroy();
	});

	it('restores a failure without a previous successful sync', () => {
		const h = createHarness({ ...savedFailure(), lastSync: null });
		expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE, lastSync: null });
		h.engine.destroy();
	});

	it('provides a fallback for older history without error details', () => {
		const settings = savedFailure();
		delete settings.syncHistory[0]!.errors;
		const h = createHarness(settings);
		expect(h.engine.getState().status).toBe('error');
		expect(h.engine.getState().lastError).toContain('last sync failed');
		h.engine.destroy();
	});

	it('does not revive an older failure after a successful attempt', () => {
		const settings = savedFailure();
		recordSyncHistory(settings, 'sync', createEmptySyncResult());
		const h = createHarness(settings);
		expect(h.engine.getState()).toMatchObject({ status: 'idle', lastError: null, lastSync });
		h.engine.destroy();
	});

	it('starts without an error when there is no history', () => {
		const h = createHarness();
		expect(h.engine.getState()).toMatchObject({ status: 'idle', lastError: null, lastSync: null });
		h.engine.destroy();
	});
});
