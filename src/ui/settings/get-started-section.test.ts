import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockButtonComponent, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import type { RegisteredDevice } from '../../protocol/sync-types';

const writeSyncSettings = vi.fn(async () => {});
const loadConnectedDevices = vi.fn(async (): Promise<RegisteredDevice[] | null> => null);
const openActivity = vi.fn();

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

const buttons: MockButtonComponent[] = [];

async function load() {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), ButtonComponent: class extends MockButtonComponent {
		constructor(containerEl: FakeElement) { super(containerEl); buttons.push(this); }
	} }));
	vi.doMock('../../plugin/sync-connection', () => ({ writeSyncSettings }));
	vi.doMock('../../plugin/settings-ui-state', () => ({ loadConnectedDevices }));
	vi.doMock('./add-device-modal', () => ({ AddDeviceModal: class { open = vi.fn(); }, canAddDeviceWithCode: () => true }));
	vi.doMock('./reminders-web-app', () => ({ showWebAppCode: vi.fn() }));
	vi.doMock('../activity/activity-modal', () => ({ ActivityModal: class { open() { openActivity(); } } }));
	vi.doMock('../sync-error-notice', () => ({ showSyncErrorNotice: vi.fn() }));
	vi.doMock('../../sync/conflict/conflict', () => ({ notifyConflicts: vi.fn() }));
	return import('./get-started-section');
}

function device(overrides: Partial<RegisteredDevice>): RegisteredDevice {
	return { id: 'id', device_id: 'd', device_name: 'Device', platform: 'android', created_at: '', last_seen_at: null, is_current: false, ...overrides };
}

function plugin(options: { configured: boolean; automaticSync?: boolean; lastSync?: string; reminders?: boolean; dismissed?: boolean }) {
	const listeners = new Set<() => void>();
	const settings = { automaticSync: options.automaticSync ?? false, lastSync: options.lastSync ?? null, getStartedDismissed: options.dismissed ?? false, reading: { enabled: false } };
	return {
		settings,
		remindersSettings: { enabled: options.reminders ?? false },
		settingsUiState: { devices: null },
		syncRuntime: {
			isConfigured: () => options.configured,
			sync: vi.fn(async () => {
				settings.lastSync = '2026-11-01T00:00:00.000Z';
				for (const listener of listeners) listener();
				return { outcome: 'completed', success: true, conflicts: [] };
			}),
			addStateChangeListener: (listener: () => void) => { listeners.add(listener); },
			removeStateChangeListener: (listener: () => void) => { listeners.delete(listener); },
		},
		writeSettings: vi.fn(async () => {}),
	};
}

function find(root: FakeElement, match: (element: FakeElement) => boolean): FakeElement | undefined {
	for (const child of root.children) {
		if (match(child)) return child;
		const nested = find(child, match);
		if (nested) return nested;
	}
	return undefined;
}

function text(root: FakeElement, cls: string): string | undefined {
	return find(root, element => element.classNames.has(cls))?.textContent;
}

/** A step row, with its description and action button when it shows them. */
function step(root: FakeElement, name: string) {
	const row = find(root, element => element.classNames.has('crate-get-started-step')
		&& find(element, child => child.classNames.has('crate-get-started-name') && child.textContent === name) !== undefined);
	if (!row) throw new Error(`Missing step: ${name}`);
	return {
		done: row.classNames.has('is-done'),
		upcoming: row.classNames.has('is-upcoming'),
		desc: text(row, 'crate-get-started-desc'),
		button: buttons.find(button => button.buttonEl.parentElement === row),
	};
}

function hideButton(): MockButtonComponent {
	const button = buttons.find(candidate => candidate.buttonEl.parentElement?.classNames.has('crate-get-started-header'));
	if (!button) throw new Error('Missing hide button');
	return button;
}

beforeEach(() => { resetObsidianUiMocks(); buttons.length = 0; });
afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
});

it('counts only other Obsidian devices and web app sessions', async () => {
	const { connectedDeviceKinds } = await load();
	expect(connectedDeviceKinds(null)).toEqual({ otherDevice: false, webApp: false });
	expect(connectedDeviceKinds([device({ is_current: true, platform: 'macos' }), device({ platform: 'shortcut' })]))
		.toEqual({ otherDevice: false, webApp: false });
	expect(connectedDeviceKinds([device({ platform: 'ios' }), device({ platform: 'pwa' })]))
		.toEqual({ otherDevice: true, webApp: true });
});

it('stays hidden until a server is connected', async () => {
	const { renderGetStartedSection, renderShowGetStartedSetting } = await load();
	const root = new FakeElement('div');
	renderGetStartedSection({ containerEl: root as never, plugin: plugin({ configured: false }) as never, rerender: vi.fn() });
	renderShowGetStartedSetting({ containerEl: root as never, plugin: plugin({ configured: false, dismissed: true }) as never, rerender: vi.fn() });
	expect(root.children).toHaveLength(0);
	expect(loadConnectedDevices).not.toHaveBeenCalled();
});

it('runs the first sync with its activity open and moves on to adding a device', async () => {
	const { renderGetStartedSection } = await load();
	const root = new FakeElement('div');
	const connected = plugin({ configured: true });
	renderGetStartedSection({ containerEl: root as never, plugin: connected as never, rerender: vi.fn() });
	const sync = step(root, 'Run your first sync');
	expect(sync.button?.buttonEl.classNames.has('mod-cta')).toBe(true);
	sync.button?.click();
	await flush();
	expect(openActivity).toHaveBeenCalledOnce();
	expect(connected.syncRuntime.sync).toHaveBeenCalled();
	expect(step(root, 'Run your first sync').done).toBe(true);
	expect(step(root, 'Add another device').button?.buttonEl.textContent).toBe('Add a device');
	expect(text(root, 'crate-get-started-count')).toBe('1 of 5');
});

it('keeps Sync now disabled while its sync rebuilds the card', async () => {
	const { renderGetStartedSection } = await load();
	const root = new FakeElement('div');
	const connected = plugin({ configured: true });
	let finish!: () => void;
	const listeners: Array<() => void> = [];
	connected.syncRuntime.addStateChangeListener = (listener: () => void) => { listeners.push(listener); };
	connected.syncRuntime.sync.mockImplementationOnce(async () => {
		for (const listener of listeners) listener();
		await new Promise<void>(resolve => { finish = resolve; });
		return { outcome: 'completed', success: true, conflicts: [] };
	});
	renderGetStartedSection({ containerEl: root as never, plugin: connected as never, rerender: vi.fn() });
	step(root, 'Run your first sync').button?.click();
	await flush();
	const rebuilt = step(root, 'Run your first sync').button;
	expect(rebuilt?.buttonEl.classNames.has('is-disabled')).toBe(true);
	rebuilt?.click();
	await flush();
	expect(connected.syncRuntime.sync).toHaveBeenCalledTimes(1);
	finish();
	await flush();
	expect(step(root, 'Run your first sync').button?.buttonEl.classNames.has('is-disabled')).toBe(false);
});

it('lists features and the web app as steps after sync and devices', async () => {
	loadConnectedDevices.mockResolvedValueOnce([device({ is_current: true }), device({ platform: 'ios' })]);
	const { renderGetStartedSection } = await load();
	const root = new FakeElement('div');
	renderGetStartedSection({ containerEl: root as never, plugin: plugin({ configured: true, lastSync: '2026-11-01', reminders: true }) as never, rerender: vi.fn() });
	await flush();
	expect(text(root, 'crate-get-started-count')).toBe('3 of 5');
	expect(step(root, 'Turn on reminders').done).toBe(true);
	expect(step(root, 'Turn on Reading').button?.buttonEl.textContent).toBe('Show');
	expect(step(root, 'Install the web app')).toMatchObject({ upcoming: true, button: undefined });
});

it('finishes setup once the web app is connected', async () => {
	loadConnectedDevices.mockResolvedValueOnce([device({ platform: 'ios' }), device({ platform: 'pwa' })]);
	const { renderGetStartedSection } = await load();
	const root = new FakeElement('div');
	const connected = plugin({ configured: true, lastSync: '2026-11-01', reminders: true });
	connected.settings.reading.enabled = true;
	renderGetStartedSection({ containerEl: root as never, plugin: connected as never, rerender: vi.fn() });
	await flush();
	expect(text(root, 'crate-get-started-count')).toBe('All set');
	expect(text(root, 'crate-get-started-subtitle')).toBe('Also try');
});

it('turns on automatic sync from the suggestions', async () => {
	const { renderGetStartedSection } = await load();
	const rerender = vi.fn();
	const root = new FakeElement('div');
	renderGetStartedSection({ containerEl: root as never, plugin: plugin({ configured: true }) as never, rerender });
	step(root, 'Automatic sync').button?.click();
	await flush();
	expect(writeSyncSettings).toHaveBeenCalledWith(expect.anything(), { automaticSync: true });
	expect(rerender).toHaveBeenCalled();
});

it('hides the checklist and brings it back from settings', async () => {
	const { renderGetStartedSection, renderShowGetStartedSetting } = await load();
	const shown = plugin({ configured: true });
	renderGetStartedSection({ containerEl: new FakeElement('div') as never, plugin: shown as never, rerender: vi.fn() });
	renderShowGetStartedSetting({ containerEl: new FakeElement('div') as never, plugin: shown as never, rerender: vi.fn() });
	expect(MockSetting.instances).toHaveLength(0);
	hideButton().click();
	await flush();
	expect(shown.writeSettings).toHaveBeenCalledWith({ getStartedDismissed: true });

	resetObsidianUiMocks();
	buttons.length = 0;
	const hidden = plugin({ configured: true, dismissed: true });
	renderGetStartedSection({ containerEl: new FakeElement('div') as never, plugin: hidden as never, rerender: vi.fn() });
	renderShowGetStartedSetting({ containerEl: Object.assign(new FakeElement('div'), { closest: () => null }) as never, plugin: hidden as never, rerender: vi.fn() });
	expect(buttons).toHaveLength(0);
	const show = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Get started')?.buttons[0];
	expect(show?.buttonEl.textContent).toBe('Show');
	show?.click();
	await flush();
	expect(hidden.writeSettings).toHaveBeenCalledWith({ getStartedDismissed: false });
});
