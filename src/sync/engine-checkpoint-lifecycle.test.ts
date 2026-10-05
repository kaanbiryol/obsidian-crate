import { expect, it, vi } from 'vitest';
import { createHarness } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';

it.each(['write', 'read'] as const)('drains a local history checkpoint during delayed %s before shutdown completes', async boundary => {
	const { engine, vault } = createHarness({ automaticSync: false });
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const files = new Map<string, string>();
	vault.adapter.write = vi.fn(async (path: string, text: string) => {
		if (boundary === 'write') { started.resolve(); await release.promise; }
		files.set(path, text);
	});
	vault.adapter.read = vi.fn(async (path: string) => {
		if (boundary === 'read') { started.resolve(); await release.promise; }
		return files.get(path);
	});
	const saving = engine.saveHistoryCheckpoint();
	await started.promise;
	engine.destroy();
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await saving;
		await stopping;
	}
	expect(drained).toHaveBeenCalledOnce();
});

it('drains a shared history checkpoint before shutdown completes', async () => {
	const { engine, api } = createHarness({ automaticSync: false });
	const result = createDeferred<undefined>();
	const save = vi.fn(() => result.promise);
	Object.assign(api, { sharedHistory: { save } });
	const saving = engine.saveSharedHistoryCheckpoint();
	expect(save).toHaveBeenCalledOnce();
	engine.destroy();
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		result.resolve(undefined);
		await saving;
		await stopping;
	}
});
