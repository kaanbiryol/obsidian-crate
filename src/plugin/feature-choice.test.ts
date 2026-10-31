import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockModal, MockSetting, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';
import { TFile, TFolder } from '../test/mocks/obsidian';
import type CratePlugin from './CratePlugin';

const serverRequest = vi.fn();
const readReadingPolicy = vi.fn();
const restartReading = vi.fn();
const setRemindersEnabled = vi.fn(async (plugin: { remindersSettings: { enabled: boolean } }, enabled: boolean) => { plugin.remindersSettings.enabled = enabled; });
vi.mock('react-dom/client', () => ({
	createRoot: (element: { textContent: string }) => ({
		render: (node: ReactNode) => { element.textContent = renderToStaticMarkup(node); },
		unmount: vi.fn(),
	}),
}));

beforeEach(() => {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), TFile, TFolder }));
	vi.doMock('./server-request', async importOriginal => ({ ...await importOriginal<typeof import('./server-request')>(), serverRequest }));
	vi.doMock('../reading/server', () => ({ readReadingPolicy }));
	vi.doMock('../reading/runtime', () => ({ restartReading }));
	vi.doMock('../reminders/plugin-integration', () => ({ setRemindersEnabled }));
	readReadingPolicy.mockResolvedValue(null);
});
afterEach(() => {
	resetObsidianUiMocks();
	vi.clearAllMocks();
	vi.resetModules();
	for (const path of ['obsidian', './server-request', '../reading/server', '../reading/runtime', '../reminders/plugin-integration']) vi.doUnmock(path);
});

function folder(path: string, notes: string[]): TFolder {
	const root = new TFolder(path);
	const nested = new TFolder(`${path}/Nested`);
	root.children.push(nested);
	notes.forEach((name, index) => (index % 2 ? nested : root).children.push(new TFile(`${path}/${name}`)));
	return root;
}

function fixture(folders: TFolder[] = []) {
	const plugin = {
		settings: { workerUrl: 'https://crate.example', reading: { enabled: false, folderPath: 'Reading', confirmed: false } },
		remindersSettings: { enabled: false, confirmed: false, remindersFolderPath: 'Reminders' },
		secretStorage: { get: () => 'synthetic' },
		app: { vault: { configDir: '.obsidian', getAbstractFileByPath: (path: string) => folders.find(item => item.path === path) ?? null } },
		refreshSettingsTab: vi.fn(),
		writeSettings: vi.fn(async (value: { reading: typeof plugin.settings.reading }) => { plugin.settings.reading = value.reading; }),
		writeRemindersSettings: vi.fn(async (value: Partial<typeof plugin.remindersSettings>) => { plugin.remindersSettings = { ...plugin.remindersSettings, ...value }; }),
	};
	return plugin;
}

/** Answers `/features` with the server policy, and records each change this vault requests. */
function serverPolicy(initial: { reading: boolean; reminders: boolean }) {
	const policy = { ...initial, revision: 'one' };
	serverRequest.mockImplementation(async (_plugin: unknown, path: string, body?: { feature: 'reading' | 'reminders'; enabled: boolean }) => {
		if (path !== '/features') throw new Error(`Unexpected ${path}`);
		if (body) policy[body.feature] = body.enabled;
		return { ...policy };
	});
}

async function openStep(plugin: ReturnType<typeof fixture>) {
	const { offerFeatureChoice } = await import('./feature-settings');
	const done = offerFeatureChoice(plugin as unknown as CratePlugin);
	await vi.waitFor(() => expect(MockModal.instances).toHaveLength(1));
	const modal = MockModal.instances[0]!;
	const rows = MockSetting.instances.filter(setting => setting.toggles.length);
	const row = (name: string) => rows.find(setting => setting.nameEl.textContent === name)!;
	const finish = () => MockSetting.instances.flatMap(setting => setting.buttons).find(button => button.buttonEl.textContent === 'Finish')!;
	return { done, modal, rows, row, finish };
}

it('starts empty or missing folders on and says what will be stored there', async () => {
	serverPolicy({ reading: false, reminders: false });
	const plugin = fixture([folder('Reminders', [])]);
	const { done, modal, row } = await openStep(plugin);
	expect(modal.titleEl.textContent).toBe('Choose what Crate manages in this vault');
	expect(row('Reminders').toggles[0]?.value).toBe(true);
	expect(row('Reminders').descEl.textContent).toBe('Reminders/ · Crate stores your reminders and projects here as Markdown notes.');
	expect(row('Reading').toggles[0]?.value).toBe(true);
	expect(row('Reading').descEl.textContent).toBe('Reading/ · Crate saves your articles and highlights here as Markdown notes.');
	expect(modal.contentEl.collectText()).toContain('You can change these later in Crate settings.');
	modal.close();
	await done;
});

it('starts folders with notes off and counts what will change, using the server Reading folder', async () => {
	serverPolicy({ reading: false, reminders: false });
	readReadingPolicy.mockResolvedValue({ enabled: false, folder_path: 'Library', revision: 'r' });
	const reminders = folder('Reminders', ['Inbox.md', 'Work.md', 'image.png']);
	const plugin = fixture([reminders, folder('Library', ['Article.md']), folder('Reading', ['Other.md', 'More.md'])]);
	const { done, modal, row } = await openStep(plugin);
	expect(row('Reminders').toggles[0]?.value).toBe(false);
	expect(row('Reminders').descEl.textContent).toBe('Reminders/ · 2 notes. Turning this on adds a small ID comment to each task and turns dates like "tomorrow" into fixed dates.');
	expect(row('Reading').toggles[0]?.value).toBe(false);
	expect(row('Reading').descEl.textContent).toBe('Library/ · 1 note. Turning this on adds Crate frontmatter to each note.');
	modal.close();
	await done;
});

it('starts a feature the server already has on and still names the change', async () => {
	serverPolicy({ reading: true, reminders: true });
	const plugin = fixture([folder('Reminders', ['Inbox.md'])]);
	const { done, modal, row } = await openStep(plugin);
	expect(row('Reminders').toggles[0]?.value).toBe(true);
	expect(row('Reminders').descEl.textContent).toBe('Reminders/ · On for your other devices. 1 note. Turning this on adds a small ID comment to each task and turns dates like "tomorrow" into fixed dates.');
	expect(row('Reading').toggles[0]?.value).toBe(true);
	expect(row('Reading').descEl.textContent).toContain('On for your other devices.');
	modal.close();
	await done;
});

it('finish turns on and confirms only the selected features, without a second confirmation', async () => {
	serverPolicy({ reading: false, reminders: false });
	const plugin = fixture([folder('Reading', ['Saved.md'])]);
	const { done, row, finish } = await openStep(plugin);
	expect(row('Reading').toggles[0]?.value).toBe(false);
	row('Reminders').toggles[0]?.change(true);
	finish().click();
	await done;
	expect(MockModal.instances).toHaveLength(1);
	expect(plugin.remindersSettings).toMatchObject({ enabled: true, confirmed: true });
	expect(setRemindersEnabled).toHaveBeenCalledWith(plugin, true, expect.any(Function));
	expect(serverRequest).toHaveBeenCalledWith(plugin, '/features', { feature: 'reminders', enabled: true, revision: 'one' }, expect.anything());
	expect(plugin.settings.reading).toMatchObject({ enabled: false, confirmed: false });
	expect(serverRequest).not.toHaveBeenCalledWith(plugin, '/features', expect.objectContaining({ feature: 'reading' }), expect.anything());
	expect(plugin.refreshSettingsTab).toHaveBeenCalledOnce();
	expect(noticeMessages).toEqual([]);
});

it('keeps a feature the server has on unconfirmed here when it is turned off', async () => {
	serverPolicy({ reading: true, reminders: false });
	const plugin = fixture();
	const { done, row, finish } = await openStep(plugin);
	row('Reading').toggles[0]?.change(false);
	row('Reminders').toggles[0]?.change(false);
	finish().click();
	await done;
	expect(plugin.writeSettings).not.toHaveBeenCalled();
	expect(plugin.writeRemindersSettings).not.toHaveBeenCalled();
	expect(serverRequest).toHaveBeenCalledOnce();
});

it('closing without finish changes nothing', async () => {
	serverPolicy({ reading: true, reminders: false });
	const plugin = fixture();
	const { done, modal } = await openStep(plugin);
	modal.close();
	await done;
	expect(plugin.writeSettings).not.toHaveBeenCalled();
	expect(plugin.writeRemindersSettings).not.toHaveBeenCalled();
	expect(restartReading).not.toHaveBeenCalled();
	expect(setRemindersEnabled).not.toHaveBeenCalled();
	expect(plugin.refreshSettingsTab).not.toHaveBeenCalled();
	expect(serverRequest).toHaveBeenCalledOnce();
});

it('is skipped when this vault already confirmed both features, and offers only the unconfirmed one otherwise', async () => {
	serverPolicy({ reading: true, reminders: true });
	const { offerFeatureChoice } = await import('./feature-settings');
	const plugin = fixture();
	plugin.settings.reading.confirmed = true;
	plugin.remindersSettings.confirmed = true;
	await offerFeatureChoice(plugin as unknown as CratePlugin);
	expect(MockModal.instances).toHaveLength(0);
	expect(serverRequest).not.toHaveBeenCalled();

	plugin.remindersSettings.confirmed = false;
	const { done, modal, rows } = await openStep(plugin);
	expect(rows.map(row => row.nameEl.textContent)).toEqual(['Reminders']);
	modal.close();
	await done;
});

it('opens with this device folders when the server cannot be reached', async () => {
	serverRequest.mockRejectedValue(new Error('offline'));
	readReadingPolicy.mockRejectedValue(new Error('offline'));
	const plugin = fixture();
	const { done, modal, row } = await openStep(plugin);
	expect(row('Reading').descEl.textContent).toMatch(/^Reading\/ · /);
	expect(row('Reminders').toggles[0]?.value).toBe(true);
	modal.close();
	await done;
});
