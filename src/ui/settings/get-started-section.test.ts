import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeElement, MockButtonComponent, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import type { RegisteredDevice } from '../../protocol/sync-types';

const writeSyncSettings = vi.fn(async () => {});
const loadConnectedDevices = vi.fn(async (): Promise<RegisteredDevice[] | null> => null);

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

const buttons: MockButtonComponent[] = [];

async function load() {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), ButtonComponent: class extends MockButtonComponent {
		constructor(containerEl: FakeElement) { super(containerEl); buttons.push(this); }
	} }));
	vi.doMock('../../plugin/sync-connection', () => ({ writeSyncSettings }));
	vi.doMock('./devices-section', () => ({ canAddDeviceWithCode: () => true, loadConnectedDevices }));
	vi.doMock('./add-device-modal', () => ({ AddDeviceModal: class { open = vi.fn(); } }));
	vi.doMock('./reminders-web-app', () => ({ buildEnrollmentUrl: vi.fn() }));
	vi.doMock('../qr-modal', () => ({ QRModal: class { open = vi.fn(); } }));
	return import('./get-started-section');
}

function device(overrides: Partial<RegisteredDevice>): RegisteredDevice {
	return { id: 'id', device_id: 'd', device_name: 'Device', platform: 'android', created_at: '', last_seen_at: null, is_current: false, ...overrides };
}

function plugin(options: { configured: boolean; automaticSync?: boolean; dismissed?: boolean }) {
	return {
		settings: { automaticSync: options.automaticSync ?? false, getStartedDismissed: options.dismissed ?? false, reading: { enabled: false } },
		remindersSettings: { enabled: false },
		settingsUiState: { devices: null },
		syncRuntime: { isConfigured: () => options.configured },
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

it('asks for a server first and offers no device actions before one is connected', async () => {
	const { renderGetStartedSection } = await load();
	const root = new FakeElement('div');
	renderGetStartedSection({ containerEl: root as never, plugin: plugin({ configured: false }) as never, rerender: vi.fn() });
	expect(text(root, 'crate-get-started-count')).toBe('0 of 5');
	expect(step(root, 'Add another device').button).toBeUndefined();
	expect(step(root, 'Turn on automatic sync').desc).toBe('Connect a server first.');
	expect(loadConnectedDevices).not.toHaveBeenCalled();
});

it('checks steps off from the connection, sync setting and device list', async () => {
	loadConnectedDevices.mockResolvedValueOnce([device({ is_current: true }), device({ platform: 'pwa' })]);
	const { renderGetStartedSection } = await load();
	const root = new FakeElement('div');
	renderGetStartedSection({ containerEl: root as never, plugin: plugin({ configured: true, automaticSync: true }) as never, rerender: vi.fn() });
	await flush();
	expect(text(root, 'crate-get-started-count')).toBe('3 of 5');
	expect(step(root, 'Open the web app on your phone')).toMatchObject({ done: true, desc: undefined, button: undefined });
	expect(step(root, 'Add another device').button?.buttonEl.textContent).toBe('Add a device');
});

it('turns on automatic sync from the checklist', async () => {
	const { renderGetStartedSection } = await load();
	const rerender = vi.fn();
	const root = new FakeElement('div');
	renderGetStartedSection({ containerEl: root as never, plugin: plugin({ configured: true }) as never, rerender });
	step(root, 'Turn on automatic sync').button?.click();
	await flush();
	expect(writeSyncSettings).toHaveBeenCalledWith(expect.anything(), { automaticSync: true });
	expect(rerender).toHaveBeenCalled();
});

it('hides the checklist and brings it back from settings', async () => {
	const { renderGetStartedSection, renderShowGetStartedSetting } = await load();
	const shown = plugin({ configured: false });
	renderGetStartedSection({ containerEl: new FakeElement('div') as never, plugin: shown as never, rerender: vi.fn() });
	renderShowGetStartedSetting({ containerEl: new FakeElement('div') as never, plugin: shown as never, rerender: vi.fn() });
	expect(MockSetting.instances).toHaveLength(0);
	hideButton().click();
	await flush();
	expect(shown.writeSettings).toHaveBeenCalledWith({ getStartedDismissed: true });

	resetObsidianUiMocks();
	buttons.length = 0;
	const hidden = plugin({ configured: false, dismissed: true });
	renderGetStartedSection({ containerEl: new FakeElement('div') as never, plugin: hidden as never, rerender: vi.fn() });
	renderShowGetStartedSetting({ containerEl: Object.assign(new FakeElement('div'), { closest: () => null }) as never, plugin: hidden as never, rerender: vi.fn() });
	expect(buttons).toHaveLength(0);
	const show = MockSetting.instances.find(setting => setting.nameEl.textContent === 'Get started')?.buttons[0];
	expect(show?.buttonEl.textContent).toBe('Show');
	show?.click();
	await flush();
	expect(hidden.writeSettings).toHaveBeenCalledWith({ getStartedDismissed: false });
});
