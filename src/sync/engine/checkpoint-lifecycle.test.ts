import { expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { createDeferred } from '../runtime/runtime-test-harness';

const unexpectedRequest = vi.fn(async (): Promise<never> => { throw new Error('Unexpected network request'); });

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
