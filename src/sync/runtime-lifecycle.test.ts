import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { SyncQueueController } from './queue-controller';
import { createEmptySyncResult } from './sync-result';
import type { SyncResult } from '../plugin/types';
import {
	createDeferred,
	createRuntimeHarness,
	flushMicrotasks,
	isAcceptingEvents,
	type Deferred,
} from './runtime-test-harness';

describe('SyncRuntime teardown and reinitialization', () => {
	let startupSyncs: Deferred<SyncResult>[];
	let queuedStartupSyncs: Deferred<SyncResult>[];

	beforeEach(() => {
		startupSyncs = [createDeferred<SyncResult>(), createDeferred<SyncResult>()];
		queuedStartupSyncs = [...startupSyncs];

		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(async () => {
			const nextSync = queuedStartupSyncs.shift();
			return nextSync ? nextSync.promise : createEmptySyncResult();
		});
		vi.spyOn(SyncQueueController.prototype as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const startupSync of startupSyncs) {
			startupSync.resolve(createEmptySyncResult());
		}
		await flushMicrotasks();
		vi.restoreAllMocks();
	});

	it('keeps events paused until the latest startup sync finishes after reinitialize', async () => {
		const { runtime } = createRuntimeHarness();
		const destroy = vi.spyOn(SyncEngine.prototype, 'destroy');

		await runtime.initialize();
		await runtime.initialize();

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSyncs[0]?.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(isAcceptingEvents(runtime)).toBe(false);

		runtime.onFileChange({ path: 'notes/still-blocked.md' } as never);
		expect(runtime.getPendingPaths()).toEqual([]);

		startupSyncs[1]?.resolve(createEmptySyncResult());
		await vi.waitFor(() => {
			expect(isAcceptingEvents(runtime)).toBe(true);
		});

		runtime.onFileChange({ path: 'notes/active.md' } as never);
		expect(runtime.getPendingPaths()).toEqual(['notes/active.md']);
	});

	it('does not re-enable events after destroy while startup sync is in flight', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();
		runtime.destroy();

		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSyncs[0]?.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(isAcceptingEvents(runtime)).toBe(false);
		runtime.onFileChange({ path: 'notes/after-destroy.md' } as never);
		expect(runtime.getPendingPaths()).toEqual([]);
	});
});
