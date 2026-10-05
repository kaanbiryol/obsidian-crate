import { expect, it, vi } from 'vitest';
import type { RemoteFileVersion } from '../protocol/sync-types';
import { createEmptySyncResult } from './sync-result';
import { createDeferred, createRuntimeHarness, initializeRuntime } from './runtime-test-harness';

const version: RemoteFileVersion = {
	storage_key: 'retained-version', path: 'note.md', hash: 'a'.repeat(64), size: 1,
	reason: 'deleted', created_at: '2026-01-01T00:00:00Z', expires_at: 2_000_000_000_000,
};

it.each([true, false])('finishes a restore only after successful reconciliation (success: %s)', async success => {
	const { runtime } = createRuntimeHarness();
	const restoreFileVersion = vi.fn(async () => {});
	const finishRestore = vi.fn(async () => {});
	await initializeRuntime(runtime, {
		restoreFileVersion, finishRestore, sync: vi.fn(async () => ({ ...createEmptySyncResult(), success })),
	});
	expect((await runtime.restoreRecentFileVersion(version)).success).toBe(success);
	expect(restoreFileVersion).toHaveBeenCalledWith(version);
	expect(finishRestore).toHaveBeenCalledTimes(success ? 1 : 0);
	if (success) expect(finishRestore).toHaveBeenCalledWith(version.storage_key);
});

it.each(['restore', 'sync'] as const)('preserves pending intent when the engine changes during %s', async stage => {
	const { runtime } = createRuntimeHarness();
	const restore = createDeferred<void>();
	const sync = createDeferred<ReturnType<typeof createEmptySyncResult>>();
	const restoreFileVersion = vi.fn(() => stage === 'restore' ? restore.promise : Promise.resolve());
	const reconcile = vi.fn(() => sync.promise);
	const finishRestore = vi.fn(async () => {});
	await initializeRuntime(runtime, { restoreFileVersion, finishRestore, sync: reconcile });
	const operation = runtime.restoreRecentFileVersion(version);
	const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
	await vi.waitFor(() => expect(stage === 'restore' ? restoreFileVersion : reconcile).toHaveBeenCalledOnce());
	const newFinish = vi.fn(async () => {});
	const newSync = vi.fn(async () => createEmptySyncResult());
	await initializeRuntime(runtime, { finishRestore: newFinish, sync: newSync });
	restore.resolve();
	sync.resolve(createEmptySyncResult());
	await rejected;
	expect(finishRestore).not.toHaveBeenCalled();
	expect(newFinish).not.toHaveBeenCalled();
	expect(newSync).not.toHaveBeenCalled();
});
