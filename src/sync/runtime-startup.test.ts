import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { SyncQueueController } from './queue-controller';
import { createEmptySyncResult } from './sync-result';
import { SyncRuntime } from './runtime';
import type { SyncResult } from './types';
import {
	createDeferred,
	createRuntimeHarness,
	flushMicrotasks,
	isAcceptingEvents,
	type Deferred,
} from './runtime-test-harness';

describe('SyncRuntime startup event handling', () => {
	let startupSync: Deferred<SyncResult>;

	beforeEach(() => {
		startupSync = createDeferred<SyncResult>();

		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(async () => startupSync.promise);
		vi.spyOn(SyncEngine.prototype, 'hasUnsyncedLocalChanges').mockResolvedValue(false);
		vi.spyOn(SyncQueueController.prototype as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
	});

	afterEach(async () => {
		startupSync.resolve(createEmptySyncResult());
		await flushMicrotasks();
		vi.restoreAllMocks();
	});

	it('ignores vault discovery before layout readiness and keeps manual sync available', async () => {
		const { runtime, plugin } = createRuntimeHarness({ automaticSync: false });
		const sync = vi.spyOn(SyncEngine.prototype, 'sync');
		plugin.app.workspace.layoutReady = false;
		await runtime.initialize();
		expect(sync).not.toHaveBeenCalled();
		runtime.onFileChange({ path: 'existing.md' } as never);
		runtime.onFileDelete({ path: 'removed.md' } as never);
		runtime.onFileRename({ path: 'renamed.md' } as never, 'old.md');
		expect(runtime.getPendingPaths()).toEqual([]);
		plugin.app.workspace.layoutReady = true;
		runtime.onFileChange({ path: 'edited.md' } as never);
		expect(runtime.getPendingPaths()).toEqual(['edited.md']);
		startupSync.resolve(createEmptySyncResult());
		await runtime.sync();
		expect(sync).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: 'create',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/new.md' } as never),
		},
		{
			name: 'edit',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/existing.md' } as never),
		},
		{
			name: 'delete',
			invoke: (runtime: SyncRuntime) => runtime.onFileDelete({ path: 'notes/removed.md' } as never),
		},
		{
			name: 'rename',
			invoke: (runtime: SyncRuntime) => runtime.onFileRename(
				{ path: 'notes/renamed.md' } as never,
				'notes/original.md',
			),
		},
	])('ignores $name events while startup sync is in flight', async ({ invoke }) => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expect(isAcceptingEvents(runtime)).toBe(false);

		invoke(runtime);

		expect(runtime.getPendingPaths()).toEqual([]);
	});

	it('starts accepting events after startup sync finishes', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expect(isAcceptingEvents(runtime)).toBe(false);
		let startupWaitSettled = false;
		void runtime.waitForStartupSync().then(() => {
			startupWaitSettled = true;
		});
		await flushMicrotasks();
		expect(startupWaitSettled).toBe(false);

		startupSync.resolve(createEmptySyncResult());
		expect(await runtime.waitForStartupSync()).toBe(true);
		await vi.waitFor(() => {
			expect(isAcceptingEvents(runtime)).toBe(true);
		});

		runtime.onFileChange({ path: 'notes/existing.md' } as never);
		runtime.onFileChange({ path: 'notes/existing.md' } as never);

		expect(runtime.getPendingPaths()).toEqual(['notes/existing.md']);
	});

	it('still forwards conflict-copy deletes while startup sync is in flight', async () => {
		const onFileDelete = vi.spyOn(SyncEngine.prototype, 'onFileDelete');
		const { runtime } = createRuntimeHarness();
		await runtime.initialize();
		const conflictFile = {
			path: 'notes/shared (conflict 2026-01-02 03-04-05 ab12).md',
		} as never;

		runtime.onFileDelete(conflictFile);

		expect(onFileDelete).toHaveBeenCalledWith(conflictFile);
	});

	it('runs one recovery pass when a visible edit was missed during startup sync', async () => {
		vi.spyOn(SyncEngine.prototype, 'hasUnsyncedLocalChanges').mockResolvedValue(true);
		const sync = vi.spyOn(SyncEngine.prototype, 'sync');
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();
		startupSync.resolve(createEmptySyncResult());

		await expect(runtime.waitForStartupSync()).resolves.toBe(true);
		expect(sync).toHaveBeenCalledTimes(2);
		expect(isAcceptingEvents(runtime)).toBe(true);
	});
});
