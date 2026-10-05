import { expect, it, vi } from 'vitest';
import { finishInitialSetup } from './initial-setup';
import type { InitialConfigPull } from './initial-config-pull';
import type { InitialImportApi } from './worker-api/initial-import';

function setup() {
	let checkpoint: InitialConfigPull | undefined = { configDir: '.config', files: { '.config/a.json': 'a', '.config/b.json': 'b' } };
	const controller = new AbortController();
	const manifest = {
		getInitialConfigPull: () => checkpoint,
		setInitialConfigPull: vi.fn((value: InitialConfigPull | undefined) => { checkpoint = value; }),
		hasFile: vi.fn((path: string) => path.endsWith('a.json')),
		save: vi.fn(async () => {}),
	};
	const context = {
		manifest, lastSeq: 0,
		initialImport: { isPreparingReminders: () => true, finishReminderSetup: vi.fn<InitialImportApi['finishReminderSetup']>(async () => {}) },
		prepareReminderScope: vi.fn(async () => {}), reportWork: vi.fn(), assertActive: () => controller.signal.throwIfAborted(),
	};
	return { context, controller };
}

it('retains an incomplete initial pull until all files arrive or the server cursor advances', async () => {
	const { context } = setup();
	await finishInitialSetup(context);
	expect(context.manifest.getInitialConfigPull()).toBeDefined();
	expect(context.manifest.save).not.toHaveBeenCalled();
	expect(context.initialImport.finishReminderSetup).toHaveBeenCalledOnce();
});

it.each(['files', 'cursor'] as const)('persists completed %s before preparing reminder scope and reporting readiness', async mode => {
	const { context } = setup();
	if (mode === 'files') context.manifest.hasFile.mockReturnValue(true);
	else context.lastSeq = 1;
	let release!: () => void;
	context.manifest.save.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
	const running = finishInitialSetup(context);
	expect(context.prepareReminderScope).not.toHaveBeenCalled();
	release();
	await running;
	expect(context.manifest.getInitialConfigPull()).toBeUndefined();
	expect(context.prepareReminderScope).toHaveBeenCalledOnce();
	expect(context.initialImport.finishReminderSetup).toHaveBeenCalledOnce();
	expect(context.reportWork).toHaveBeenCalledWith({ phase: 'reminders' });
});

it.each(['storage', 'shutdown'] as const)('does not proceed to readiness after %s interrupts checkpoint persistence', async reason => {
	const { context, controller } = setup();
	context.lastSeq = 1;
	context.manifest.save.mockImplementation(async () => {
		if (reason === 'storage') throw new Error('Disk unavailable');
		controller.abort();
	});
	await expect(finishInitialSetup(context)).rejects.toThrow();
	expect(context.prepareReminderScope).not.toHaveBeenCalled();
	expect(context.initialImport.finishReminderSetup).not.toHaveBeenCalled();
});

it('stops after scope preparation is cancelled and leaves the server readiness marker intact', async () => {
	const { context, controller } = setup();
	context.prepareReminderScope.mockImplementation(async () => { controller.abort(); });
	await expect(finishInitialSetup(context)).rejects.toMatchObject({ name: 'AbortError' });
	expect(context.initialImport.finishReminderSetup).not.toHaveBeenCalled();
});
