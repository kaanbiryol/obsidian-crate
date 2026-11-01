import { ButtonComponent, Notice, Setting, setIcon } from 'obsidian';
import type { RegisteredDevice } from '../../protocol/sync-types';
import { errorMessage } from '../../platform/logger';
import { writeSyncSettings } from '../../plugin/sync-connection';
import { QRModal } from '../qr-modal';
import { AddDeviceModal } from './add-device-modal';
import { canAddDeviceWithCode, loadConnectedDevices } from './devices-section';
import { buildEnrollmentUrl } from './reminders-web-app';
import type { SettingsSectionContext } from './section-helpers';

interface GetStartedStep {
	name: string;
	desc: string;
	done: boolean;
	/** Offered while the step is not done. */
	action?: { label: string; run: () => void | Promise<void> };
}

/** Devices this checklist reads to tell whether another device or the web app is connected. */
export function connectedDeviceKinds(devices: RegisteredDevice[] | null): { otherDevice: boolean; webApp: boolean } {
	const others = devices?.filter(device => !device.is_current) ?? [];
	return {
		otherDevice: others.some(device => device.platform !== 'pwa' && device.platform !== 'shortcut'),
		webApp: others.some(device => device.platform === 'pwa'),
	};
}

/** First steps, each checked off from this device's real state. Hidden once dismissed. */
export function renderGetStartedSection(context: SettingsSectionContext): () => void {
	const { containerEl, plugin, rerender } = context;
	if (plugin.settings.getStartedDismissed) return () => {};

	const card = containerEl.createDiv({ cls: 'crate-get-started' });
	let devices: RegisteredDevice[] | null = plugin.settingsUiState.devices?.tokens ?? null;
	let disposed = false;

	const render = () => {
		card.empty();
		const steps = buildSteps(context, devices);
		const done = steps.filter(step => step.done).length;
		const header = card.createDiv({ cls: 'crate-get-started-header' });
		header.createDiv({ cls: 'crate-get-started-title', text: 'Get started' });
		header.createSpan({ cls: 'crate-get-started-count', text: done === steps.length ? 'All set' : `${done} of ${steps.length}` });
		new ButtonComponent(header).setButtonText(done === steps.length ? 'Done' : 'Hide').onClick(async () => {
			try {
				await plugin.writeSettings({ getStartedDismissed: true });
				rerender();
			} catch (error) {
				new Notice(`Could not save settings: ${errorMessage(error)}`);
			}
		});
		const progress = card.createDiv({ cls: 'crate-get-started-progress' });
		progress.setCssProps({ '--crate-get-started-progress': `${Math.round(done / steps.length * 100)}%` });
		progress.createDiv({ cls: 'crate-get-started-progress-fill' });

		const list = card.createDiv({ cls: 'crate-get-started-steps' });
		for (const step of steps) {
			const row = list.createDiv({ cls: 'crate-get-started-step' });
			if (step.done) row.addClass('is-done');
			setIcon(row.createSpan({ cls: 'crate-get-started-icon' }), step.done ? 'circle-check' : 'circle');
			const body = row.createDiv({ cls: 'crate-get-started-body' });
			body.createDiv({ cls: 'crate-get-started-name', text: step.name });
			if (step.done) continue;
			body.createDiv({ cls: 'crate-get-started-desc', text: step.desc });
			const { action } = step;
			if (!action) continue;
			const button = new ButtonComponent(row).setButtonText(action.label).onClick(async () => {
				button.setDisabled(true);
				try { await action.run(); } finally { if (!disposed) button.setDisabled(false); }
			});
		}
	};

	render();
	if (plugin.syncRuntime.isConfigured() && devices === null) {
		void loadConnectedDevices(plugin).then(tokens => {
			if (disposed) return;
			devices = tokens;
			render();
		}).catch(() => { /* The device steps stay unchecked when the list cannot load. */ });
	}
	return () => { disposed = true; };
}

function buildSteps({ containerEl, plugin, rerender }: SettingsSectionContext, devices: RegisteredDevice[] | null): GetStartedStep[] {
	const connected = plugin.syncRuntime.isConfigured();
	const { otherDevice, webApp } = connectedDeviceKinds(devices);
	const featuresOn = plugin.remindersSettings.enabled || plugin.settings.reading.enabled;
	const later = (step: string) => connected ? step : 'Connect a server first.';
	return [
		{
			name: 'Connect a server',
			desc: connected ? 'This vault syncs with your server.' : 'Sign in with Cloudflare, paste a pairing link, or use your own server below.',
			done: connected,
		},
		{
			name: 'Turn on automatic sync',
			desc: later('Sync after edits, on startup, and at an interval.'),
			done: connected && plugin.settings.automaticSync,
			action: connected ? { label: 'Turn on', run: async () => {
				try {
					await writeSyncSettings(plugin, { automaticSync: true });
					rerender();
				} catch (error) {
					new Notice(`Failed to save sync settings: ${errorMessage(error)}`);
				}
			} } : undefined,
		},
		{
			name: 'Add another device',
			desc: later('Sync this vault to Obsidian on your phone or another computer.'),
			done: otherDevice,
			action: connected ? { label: 'Add a device', run: () => {
				if (canAddDeviceWithCode(plugin)) new AddDeviceModal(plugin).open();
				else openSettingsSection(containerEl, 'Account and devices');
			} } : undefined,
		},
		{
			name: 'Open the web app on your phone',
			desc: later('Reminder notifications and Reading, from your home screen.'),
			done: webApp,
			action: connected ? { label: 'Show code', run: async () => {
				try {
					new QRModal(plugin.app, await buildEnrollmentUrl(plugin)).open();
				} catch (error) {
					new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
				}
			} } : undefined,
		},
		{
			name: 'Turn on reminders or Reading',
			desc: 'Optional. Choose them under Features below.',
			done: featuresOn,
			action: { label: 'Show features', run: () => { openSettingsSection(containerEl, 'Features'); } },
		},
	];
}

/** Opens a settings disclosure or scrolls to a section heading by its title. */
function openSettingsSection(containerEl: HTMLElement, title: string): void {
	const root = containerEl.closest('.crate-settings') ?? containerEl;
	const details = root.querySelector<HTMLDetailsElement>(`details[data-settings-section="${title}"]`);
	if (details) {
		details.open = true;
		details.dispatchEvent(new Event('toggle'));
		details.scrollIntoView({ behavior: 'smooth', block: 'start' });
		details.querySelector('summary')?.focus();
		return;
	}
	const heading = Array.from(root.querySelectorAll<HTMLElement>('.crate-settings-section-heading'))
		.find(element => element.querySelector('.setting-item-name')?.textContent === title);
	heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** A settings row that brings the checklist back after it was hidden. */
export function renderShowGetStartedSetting({ containerEl, plugin, rerender }: SettingsSectionContext): void {
	if (!plugin.settings.getStartedDismissed) return;
	new Setting(containerEl)
		.setName('Get started')
		.setDesc('Show the setup checklist at the top of these settings.')
		.addButton(button => button.setButtonText('Show').onClick(async () => {
			button.setDisabled(true);
			try {
				await plugin.writeSettings({ getStartedDismissed: false });
				rerender();
				containerEl.closest('.crate-settings')?.querySelector('.crate-get-started')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			} catch (error) {
				new Notice(`Could not save settings: ${errorMessage(error)}`);
				button.setDisabled(false);
			}
		}));
}
