import { expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { createDeferred } from './runtime-test-harness';
import { TEST_PLUGIN_DIR } from '../test/factories/sync-vault';

const unexpectedRequest = vi.fn(async (): Promise<never> => { throw new Error('Unexpected network request'); });

it.each(['write', 'read'] as const)('drains a local history checkpoint during delayed %s before shutdown completes', async boundary => {
	const { engine, vault, disk } = await createPersistentEngineHarness(unexpectedRequest);
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const write = vault.adapter.write.bind(vault.adapter);
	const read = vault.adapter.read.bind(vault.adapter);
	vi.spyOn(vault.adapter, 'write').mockImplementation(async (path, text) => {
		if (boundary === 'write') { started.resolve(); await release.promise; }
		await write(path, text);
	});
	vi.spyOn(vault.adapter, 'read').mockImplementation(async path => {
		if (boundary === 'read') { started.resolve(); await release.promise; }
		return read(path);
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
	const id = await saving;
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/history-checkpoints/${id}.json`))).toMatchObject({
		authority: 'https://server.test', files: {},
	});
});

it('drains a shared history checkpoint before shutdown completes', async () => {
	const { engine, api } = await createPersistentEngineHarness(unexpectedRequest);
	const result = createDeferred<undefined>();
	const save = vi.spyOn(api.sharedHistory, 'save').mockImplementation(() => result.promise);
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
