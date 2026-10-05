import { afterEach, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { createDeferred, createRuntimeHarness, expectFileEventsAccepted, initializeRuntime } from './runtime-test-harness';

afterEach(() => vi.restoreAllMocks());

it('rejects encryption setup destroyed before its queued work starts', async () => {
	const { runtime } = createRuntimeHarness();
	const operation = vi.fn(async () => {});
	const initialize = vi.spyOn(runtime, 'initialize').mockResolvedValue(undefined);
	const setup = runtime.runEncryptionSetup(operation);
	runtime.destroy();
	await expect(setup).rejects.toMatchObject({ name: 'AbortError' });
	expect(operation).not.toHaveBeenCalled();
	expect(initialize).not.toHaveBeenCalled();
});

it('does not start encryption conversion after destruction while draining', async () => {
	const { runtime } = createRuntimeHarness();
	await initializeRuntime(runtime);
	const drained = createDeferred<void>();
	const waitForIdle = vi.spyOn(SyncEngine.prototype, 'waitForIdle').mockReturnValueOnce(drained.promise);
	const initialize = vi.spyOn(runtime, 'initialize').mockResolvedValue(undefined);
	const operation = vi.fn(async () => {});
	const setup = runtime.runEncryptionSetup(operation);
	await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalled());
	runtime.destroy();
	drained.resolve();
	await expect(setup).rejects.toMatchObject({ name: 'AbortError' });
	expect(operation).not.toHaveBeenCalled();
	expect(initialize).not.toHaveBeenCalled();
	expectFileEventsAccepted(runtime, false);
});

it('does not restart after destruction while encryption conversion is pending', async () => {
	const { runtime } = createRuntimeHarness();
	const converted = createDeferred<void>();
	const operation = vi.fn(() => converted.promise);
	const initialize = vi.spyOn(runtime, 'initialize').mockResolvedValue(undefined);
	const setup = runtime.runEncryptionSetup(operation);
	await vi.waitFor(() => expect(operation).toHaveBeenCalled());
	runtime.destroy();
	converted.resolve();
	await expect(setup).rejects.toMatchObject({ name: 'AbortError' });
	expect(initialize).not.toHaveBeenCalled();
	expectFileEventsAccepted(runtime, false);
});

it('resumes the same runtime after successful encryption setup', async () => {
	const { runtime } = createRuntimeHarness();
	vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
	const operation = vi.fn(async () => {});
	await runtime.runEncryptionSetup(operation);
	expect(operation).toHaveBeenCalledOnce();
	expect(runtime.isInitialized()).toBe(true);
	expectFileEventsAccepted(runtime, true);
});
