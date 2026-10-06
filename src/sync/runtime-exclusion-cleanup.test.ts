import { expect, it, vi } from 'vitest';
import { createDeferred, createRuntimeHarness, initializeRuntime } from './runtime-test-harness';

it.each(['review', 'confirmation'] as const)('rejects cleanup when its engine is replaced during %s', async stage => {
	const { runtime } = createRuntimeHarness();
	const execute = vi.fn(async () => ({ deleted: ['.trash/old.md'], errors: [] }));
	const review = { paths: ['.trash/old.md'], execute };
	const prepared = createDeferred<typeof review>();
	await initializeRuntime(runtime, { createExclusionCleanupReview: () => prepared.promise });
	const preparing = runtime.createExclusionCleanupReview();
	if (stage === 'review') {
		await initializeRuntime(runtime);
		prepared.resolve(review);
		await expect(preparing).rejects.toThrow('Sync connection changed');
	} else {
		prepared.resolve(review);
		const confirmed = await preparing;
		await initializeRuntime(runtime);
		await expect(confirmed.execute()).rejects.toThrow('Sync connection changed');
	}
	expect(execute).not.toHaveBeenCalled();
});
