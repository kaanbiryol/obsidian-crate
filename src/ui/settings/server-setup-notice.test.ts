import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

async function render(options: { issues?: object[]; reading?: string; configured?: boolean; unreachable?: boolean } = {}) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	const ensureServerSetup = vi.fn(async () => ({ issues: [], unreachable: options.unreachable ?? false }));
	vi.doMock('../../plugin/server-setup', () => ({ ensureServerSetup, serverSetupIssues: () => options.issues ?? [] }));
	vi.doMock('../../reading/runtime', () => ({ readingSetupError: () => options.reading }));
	const { renderServerSetupNotice } = await import('./server-setup-notice');
	const rerender = vi.fn();
	const plugin = { syncRuntime: { isConfigured: () => options.configured ?? true } };
	renderServerSetupNotice({ containerEl: new FakeElement('div'), plugin, rerender } as never);
	return { plugin, rerender, ensureServerSetup };
}

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../plugin/server-setup');
	vi.doUnmock('../../reading/runtime');
});

it('stays hidden when setup finished or no server is connected', async () => {
	await render();
	expect(MockSetting.instances).toHaveLength(0);
	await render({ reading: 'failed', configured: false });
	expect(MockSetting.instances).toHaveLength(0);
});

it('explains each failing step with the latest Reading answer and completes setup', async () => {
	const { plugin, rerender, ensureServerSetup } = await render({
		issues: [{ step: 'features', message: 'Offline.' }, { step: 'reading', message: 'An older attempt.' }],
		reading: 'Encrypted sync is not ready.',
	});
	const [setting] = MockSetting.instances;
	expect(setting!.nameEl.textContent).toBe('Server setup isn’t complete');
	expect(setting!.descEl.textContent).toContain('Shared features: Offline. · Reading: Encrypted sync is not ready.');
	expect(setting!.buttons[0]!.buttonEl.textContent).toBe('Complete server setup');
	setting!.buttons[0]!.click();
	await vi.waitFor(() => { expect(rerender).toHaveBeenCalledOnce(); });
	expect(ensureServerSetup).toHaveBeenCalledWith(plugin);
});

it('says when the server could not be reached', async () => {
	const { rerender } = await render({ reading: 'failed', unreachable: true });
	MockSetting.instances[0]!.buttons[0]!.click();
	await vi.waitFor(() => { expect(rerender).toHaveBeenCalledOnce(); });
	expect(noticeMessages).toEqual(['Could not reach your Crate server. Check your connection and try again.']);
});
