import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement, MockSetting, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';

beforeEach(() => { resetObsidianUiMocks(); vi.doMock('obsidian', () => createObsidianUiModule()); });
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('obsidian'); });

async function setup(assertCurrent = () => {}) {
	const { renderRecoveryVerification } = await import('./recovery-verification');
	const check = vi.spyOn(await import('../../encryption/recovery-verification'), 'verifyRecoveryCode');
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders'), code = await generateRecoveryCode();
	const container = new FakeElement('div'), verified = vi.fn();
	const controller = renderRecoveryVerification(container as never, await sealRecoveryBundle(bundle, code), bundle, verified, assertCurrent);
	const setting = MockSetting.instances.at(-1)!;
	return { code, container, verified, controller, check, input: setting.texts[0]! };
}

it('automatically verifies the saved copy, rejects wrong keys, and invalidates verification when edited', async () => {
	const ui = await setup();
	expect(ui.controller.getCode()).toBeNull();
	ui.input.change(await generateRecoveryCode());
	await vi.waitFor(() => expect(ui.container.collectText()).toContain('Could not verify'));
	expect(ui.controller.getCode()).toBeNull();
	ui.input.change(ui.code);
	await vi.waitFor(() => expect(ui.controller.getCode()).toBe(ui.code));
	expect(ui.container.collectText()).toContain('Key verified');
	ui.input.change('changed');
	expect(ui.controller.getCode()).toBeNull();
	expect(ui.verified).toHaveBeenLastCalledWith(false);
});

it('cannot accept a crypto result after the input changes', async () => {
	const ui = await setup();
	ui.input.change(ui.code);
	const pending = ui.check.mock.results[0]!.value as Promise<void>;
	ui.input.change('changed during decryption');
	await pending;
	expect(ui.controller.getCode()).toBeNull();
	expect(ui.verified).not.toHaveBeenCalledWith(true);
});

it('cannot accept a crypto result after the server connection changes', async () => {
	const ui = await setup(() => { throw new Error('Connection changed'); });
	ui.input.change(ui.code);
	await vi.waitFor(() => expect(ui.container.collectText()).toContain('Could not verify'));
	expect(ui.controller.getCode()).toBeNull();
	expect(ui.verified).not.toHaveBeenCalledWith(true);
});

it.each(['reset', 'dispose'] as const)('ignores verification still running when the owner calls %s', async action => {
	const ui = await setup();
	ui.input.change(ui.code);
	const pending = ui.check.mock.results[0]!.value as Promise<void>;
	ui.controller[action]();
	await pending;
	expect(ui.controller.getCode()).toBeNull();
	expect(ui.verified).not.toHaveBeenCalledWith(true);
	if (action === 'reset') expect(ui.input.inputEl.value).toBe('');
});
