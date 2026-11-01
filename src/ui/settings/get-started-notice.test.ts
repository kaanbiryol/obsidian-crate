import { afterEach, expect, it, vi } from 'vitest';
import { createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
});

async function show(firstRun: boolean, configured: boolean) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.stubGlobal('DocumentFragment', class {
		createSpan() { return {}; }
		createEl() { return { addEventListener: vi.fn() }; }
	});
	const { showGetStartedNotice } = await import('./get-started-notice');
	const saveSettings = vi.fn(async () => {});
	showGetStartedNotice({ firstRun, saveSettings, syncRuntime: { isConfigured: () => configured } } as never);
	vi.unstubAllGlobals();
	return saveSettings;
}

it('points a fresh install to settings once and saves so it does not repeat', async () => {
	const saveSettings = await show(true, false);
	expect(noticeMessages).toHaveLength(1);
	expect(saveSettings).toHaveBeenCalledOnce();
});

it('stays quiet after the first run or once connected', async () => {
	expect(await show(false, false)).not.toHaveBeenCalled();
	expect(await show(true, true)).not.toHaveBeenCalled();
	expect(noticeMessages).toHaveLength(0);
});
