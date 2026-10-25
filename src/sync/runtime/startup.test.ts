import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from '../engine/engine';
import { buildPersistedCrateSettings, normalizeCrateSettings } from '../../plugin/settings';

import { SyncQueueController } from '../queue/controller';
import { pendingChangeKey } from '../pending/pending-change';
import { TFolder } from 'obsidian';
import { cancelSyncResult, createEmptySyncResult } from '../sync-result';
import * as conflict from '../conflict/conflict';
import { SyncRuntime } from './runtime';
import type { SyncResult } from '../types';
import {
	createDeferred,
	createRuntimeHarness as createUntrackedRuntimeHarness,
	flushMicrotasks,
	expectFileEventsAccepted,
	type Deferred,
} from './runtime-test-harness';
import { FOREGROUND_SYNC_DEBOUNCE_MS } from './foreground-sync';

const runtimes: SyncRuntime[] = [];
function createRuntimeHarness(...args: Parameters<typeof createUntrackedRuntimeHarness>) {
	const harness = createUntrackedRuntimeHarness(...args);
	runtimes.push(harness.runtime);
	return harness;
}

describe('SyncRuntime startup event handling', () => {
	let startupSync: Deferred<SyncResult>;

	beforeEach(() => {
		startupSync = createDeferred<SyncResult>();

		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(async () => startupSync.promise);
        vi.spyOn(SyncEngine.prototype, 'saveSharedHistoryCheckpoint').mockResolvedValue(undefined);
		vi.spyOn(SyncQueueController.prototype as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
	});

	afterEach(async () => {
		startupSync.resolve(createEmptySyncResult());
		for (const runtime of runtimes.splice(0)) {
			await runtime.waitForStartupSync();
			runtime.destroy();
		}
		vi.restoreAllMocks();
	});

	it('keeps a fresh install idle after connecting, restarting, and resuming until a manual sync', async () => {
		vi.useFakeTimers();
		const { runtime, settings } = createRuntimeHarness(normalizeCrateSettings(undefined, '.vault-config'));
		const sync = vi.spyOn(SyncEngine.prototype, 'sync');
		try {
			expect(settings.automaticSync).toBe(false);
			await runtime.applyInfrastructureConfig({ workerUrl: 'https://worker.example', authToken: 'auth-token' });
			expect(await runtime.waitForStartupSync()).toBe(false);

			await runtime.initialize();
			expect(await runtime.waitForStartupSync()).toBe(false);
			for (const reason of ['focus', 'visible', 'online'] as const) runtime.triggerForegroundSync(reason);
			await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
			expect(sync).not.toHaveBeenCalled();
			expect(runtime.getState().status).toBe('idle');

			startupSync.resolve(createEmptySyncResult());
			await runtime.sync();
			expect(sync).toHaveBeenCalledOnce();
			expect(settings.automaticSync).toBe(false);
		} finally {
			runtime.destroy();
			vi.useRealTimers();
		}
	});

	it('keeps automatic sync off after saving settings and restarting', async () => {
		const saved = buildPersistedCrateSettings(normalizeCrateSettings({
			automaticSync: false, syncInterval: 300,
		}, '.vault-config'));
		const reloaded = normalizeCrateSettings(JSON.parse(JSON.stringify(saved)) as typeof saved, '.vault-config');
		const { runtime } = createRuntimeHarness(reloaded);
		const sync = vi.spyOn(SyncEngine.prototype, 'sync');
		try {
			await runtime.initialize();
			expect(await runtime.waitForStartupSync()).toBe(false);
			expect(sync).not.toHaveBeenCalled();
			expectFileEventsAccepted(runtime, true);
		} finally { runtime.destroy(); }
	});

	it('checks pending membership for previews without copying the pending list', async () => {
		const { runtime } = createRuntimeHarness({ automaticSync: false });
		await runtime.initialize();
		runtime.onFileChange({ path: 'edited.md' } as never);
		expect(runtime.hasPendingKey('edited.md')).toBe(true);
		expect(runtime.hasPendingKey('other.md')).toBe(false);
		const copy = vi.spyOn(SyncEngine.prototype, 'getPendingKeys');
		const preview = { kind: 'modified', before: 'a', after: 'b' } as never;
		vi.spyOn(SyncEngine.prototype, 'loadPendingDiff').mockResolvedValue(preview);
		await expect(runtime.loadPendingDiff('edited.md', false)).resolves.toBe(preview);
		await expect(runtime.loadPendingDiff('other.md', false)).rejects.toThrow('Pending changes were updated');
		expect(copy).not.toHaveBeenCalled();
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
		expect(runtime.getPendingKeys()).toEqual([]);
		plugin.app.workspace.layoutReady = true;
		runtime.onFileChange({ path: 'edited.md' } as never);
		expect(runtime.getPendingKeys()).toEqual(['edited.md']);
		startupSync.resolve(createEmptySyncResult());
		await runtime.sync();
		expect(sync).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: 'create',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/new.md' } as never),
			queued: ['notes/new.md'],
		},
		{
			name: 'edit',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/existing.md' } as never),
			queued: ['notes/existing.md'],
		},
		{
			name: 'delete',
			invoke: (runtime: SyncRuntime) => runtime.onFileDelete({ path: 'notes/removed.md' } as never),
			queued: [pendingChangeKey('delete', 'notes/removed.md')],
		},
		{
			name: 'rename',
			invoke: (runtime: SyncRuntime) => runtime.onFileRename(
				{ path: 'notes/renamed.md' } as never,
				'notes/original.md',
			),
			queued: [pendingChangeKey('delete', 'notes/original.md'), 'notes/renamed.md'],
		},
	])('defers $name events during the startup sync and queues them once it finishes', async ({ invoke, queued }) => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expectFileEventsAccepted(runtime, false);

		invoke(runtime);

		expect(runtime.getPendingKeys()).toEqual([]);
		startupSync.resolve(createEmptySyncResult());
		await runtime.waitForStartupSync();
		expect(runtime.getPendingKeys()).toEqual(queued);
	});

	it('queues only the latest change per path and skips folders and ignored files', async () => {
		const { runtime } = createRuntimeHarness();
		await runtime.initialize();
		runtime.onFileChange({ path: 'notes/recreated.md' } as never);
		runtime.onFileDelete({ path: 'notes/recreated.md' } as never);
		runtime.onFileChange({ path: 'notes/recreated.md' } as never);
		runtime.onFileChange(Object.assign(new TFolder(), { path: 'notes' }));
		runtime.onFileChange({ path: 'notes/scratch.tmp' } as never);
		startupSync.resolve(createEmptySyncResult());
		await runtime.waitForStartupSync();
		expect(runtime.getPendingKeys()).toEqual(['notes/recreated.md']);
	});

	it('replays raw notifications for hidden files through the engine after the startup sync', async () => {
		const onRawFileChange = vi.spyOn(SyncEngine.prototype, 'onRawFileChange').mockResolvedValue();
		const { runtime } = createRuntimeHarness();
		await runtime.initialize();
		runtime.onRawFileChange('.vault-config/app.json');
		runtime.onRawFileChange('notes/visible.md');
		runtime.onFileChange({ path: 'notes/visible.md' } as never);
		expect(onRawFileChange).not.toHaveBeenCalled();
		startupSync.resolve(createEmptySyncResult());
		await runtime.waitForStartupSync();
		expect(onRawFileChange.mock.calls).toEqual([['.vault-config/app.json']]);
		expect(runtime.getPendingKeys()).toEqual(['notes/visible.md']);
	});

	it('starts accepting events after startup sync finishes', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expectFileEventsAccepted(runtime, false);
		let startupWaitSettled = false;
		void runtime.waitForStartupSync().then(() => {
			startupWaitSettled = true;
		});
		await flushMicrotasks();
		expect(startupWaitSettled).toBe(false);

		startupSync.resolve(createEmptySyncResult());
		expect(await runtime.waitForStartupSync()).toBe(true);
		await vi.waitFor(() => {
			expectFileEventsAccepted(runtime, true);
		});

		runtime.onFileChange({ path: 'notes/existing.md' } as never);
		runtime.onFileChange({ path: 'notes/existing.md' } as never);

		expect(runtime.getPendingKeys()).toEqual(['notes/existing.md']);
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

	it('does not scan the vault again after the startup sync', async () => {
		const probe = vi.spyOn(SyncEngine.prototype, 'hasUnsyncedLocalChanges');
		const sync = vi.spyOn(SyncEngine.prototype, 'sync');
		const { runtime } = createRuntimeHarness({ lastSync: '2026-10-01T00:00:00Z' });

		await runtime.initialize();
		expect(runtime.getState().initializing).toBe(true);
		startupSync.resolve(createEmptySyncResult());

		await expect(runtime.waitForStartupSync()).resolves.toBe(true);
		expect(sync).toHaveBeenCalledOnce();
		expect(probe).not.toHaveBeenCalled();
		expect(runtime.getState().initializing).toBeFalsy();
		expectFileEventsAccepted(runtime, true);
	});

	it('does not announce conflicts or report completion when the startup sync is cancelled', async () => {
		vi.spyOn(SyncEngine.prototype, 'sync').mockResolvedValueOnce(
			cancelSyncResult({ ...createEmptySyncResult(), conflicts: ['notes/startup-conflict.md'] }),
		);
		const notifyConflicts = vi.spyOn(conflict, 'notifyConflicts').mockImplementation(() => {});
		const { runtime, settings } = createRuntimeHarness();
		await runtime.initialize();
		expect(await runtime.waitForStartupSync()).toBe(false);
		expect(notifyConflicts).not.toHaveBeenCalled();
		expect(settings.syncHistory).toHaveLength(0);
	});
});
