import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement, MockSetting, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../../encryption/key-bundle';

beforeEach(() => { resetObsidianUiMocks(); vi.doMock('obsidian', () => createObsidianUiModule()); });
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('obsidian'); });

async function setup(assertCurrent = () => {}) {
	const { renderRecoveryVerification } = await import('./recovery-key-setting');
	const check = vi.spyOn(await import('../../../encryption/recovery-verification'), 'verifyRecoveryCode');
	const bundle = await createVaultKeyBundle(), code = await generateRecoveryCode();
	const container = new FakeElement('div');
	const dispose = renderRecoveryVerification(container as never, await sealRecoveryBundle(bundle, code), bundle, assertCurrent);
	const input = MockSetting.instances.at(-1)!.texts[0]!;
	const status = container.querySelector('.crate-encryption-feedback')!;
	return {
		code, dispose, check, input, status,
		verified: () => status.classNames.has('is-verified'), invalid: () => input.inputEl.getAttribute('aria-invalid'),
	};
}

it('automatically verifies the saved copy, rejects wrong keys, and invalidates verification when edited', async () => {
	const ui = await setup();
	expect(ui.status.textContent).toBe('');
	ui.input.change(await generateRecoveryCode());
	await vi.waitFor(() => expect(ui.status.textContent).toContain('Could not verify'));
	expect(ui.invalid()).toBe('true');
	ui.input.change(ui.code);
	await vi.waitFor(() => expect(ui.status.textContent).toBe('Key verified'));
	expect(ui.verified()).toBe(true);
	expect(ui.invalid()).toBe('false');
	ui.input.change('changed');
	expect(ui.status.textContent).not.toBe('Key verified');
	expect(ui.verified()).toBe(false);
});

it('cannot accept a crypto result after the input changes', async () => {
	const ui = await setup();
	ui.input.change(ui.code);
	const pending = ui.check.mock.results[0]!.value as Promise<void>;
	ui.input.change('changed during decryption');
	await pending;
	expect(ui.verified()).toBe(false);
	await vi.waitFor(() => expect(ui.status.textContent).toContain('Could not verify'));
	expect(ui.verified()).toBe(false);
});

it('cannot accept a crypto result after the server connection changes', async () => {
	const ui = await setup(() => { throw new Error('Connection changed'); });
	ui.input.change(ui.code);
	await vi.waitFor(() => expect(ui.status.textContent).toContain('Could not verify'));
	expect(ui.verified()).toBe(false);
	expect(ui.invalid()).toBe('true');
});

it('ignores verification still running when the owner disposes it', async () => {
	const ui = await setup();
	ui.input.change(ui.code);
	const pending = ui.check.mock.results[0]!.value as Promise<void>;
	ui.dispose();
	await pending;
	expect(ui.status.textContent).toBe('Checking key…');
	expect(ui.verified()).toBe(false);
	ui.input.change(ui.code);
	expect(ui.check).toHaveBeenCalledOnce();
});
