import { expect, it, vi } from 'vitest';
import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
import type { FileVersionsPage } from '../../protocol/sync-types';
import { createDeferred, createRuntimeHarness, initializeRuntime, mockApiClient } from './runtime-test-harness';

it('rejects file history loaded through a replaced connection', async () => {
	const { runtime } = createRuntimeHarness();
	await initializeRuntime(runtime);
	const page = createDeferred<FileVersionsPage>();
	mockApiClient(runtime, { listFileVersions: () => page.promise });
	const reading = runtime.listRecentFileVersions();
	await initializeRuntime(runtime);
	page.resolve({ versions: [], hasMore: false });
	await expect(reading).rejects.toMatchObject({ name: 'Error', message: 'Sync configuration changed. Reopen file history.' });
});

it('rejects shared checkpoints loaded through a replaced connection', async () => {
	const { runtime } = createRuntimeHarness();
	await initializeRuntime(runtime);
	const checkpoints = createDeferred<SharedCheckpoint[]>();
	vi.spyOn(runtime.getApiClient()!.sharedHistory, 'list').mockReturnValue(checkpoints.promise);
	const reading = runtime.listSharedCheckpoints();
	await initializeRuntime(runtime);
	checkpoints.resolve([]);
	await expect(reading).rejects.toMatchObject({ name: 'Error', message: 'Sync connection changed. Reopen history.' });
});
