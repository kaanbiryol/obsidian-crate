import { ButtonComponent, Notice, Setting, setIcon } from 'obsidian';
import type { RegisteredDevice } from '../../protocol/sync-types';
import { errorMessage } from '../../platform/logger';
import { writeSyncSettings } from '../../plugin/sync-connection';
import { QRModal } from './qr-modal';
import { AddDeviceModal, canAddDeviceWithCode } from './add-device-modal';
import { loadConnectedDevices } from '../../plugin/settings-ui-state';
import { buildEnrollmentUrl } from './reminders-web-app';
import { showSyncErrorNotice } from '../sync-error-notice';
import { ActivityModal } from '../activity/activity-modal';
import { notifyConflicts } from '../../sync/conflict/conflict';
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

/** Setup steps, each checked off from this device's real state, plus optional suggestions. Shown once a server is connected, hidden once dismissed. */
export function renderGetStartedSection(context: SettingsSectionContext): () => void {
	const { containerEl, plugin, rerender } = context;
	if (plugin.settings.getStartedDismissed || !plugin.syncRuntime.isConfigured()) return () => {};

	const card = containerEl.createDiv({ cls: 'crate-get-started' });
	let devices: RegisteredDevice[] | null = plugin.settingsUiState.devices?.tokens ?? null;
	let disposed = false;
	// Steps whose action is running. State changes rebuild the card, so each new button reads this.
	const running = new Set<string>();

	const addAction = (row: HTMLElement, name: string, action: NonNullable<GetStartedStep['action']>, cta: boolean) => {
		const button = new ButtonComponent(row).setButtonText(action.label).setDisabled(running.has(name)).onClick(async () => {
			if (running.has(name)) return;
			running.add(name);
			button.setDisabled(true);
			try { await action.run(); } finally {
				running.delete(name);
				if (!disposed) render();
			}
		});
		if (cta) button.setCta();
	};

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

		// Only the next step is expanded, so the list reads as what to do now rather than a to-do list.
		const next = steps.find(step => !step.done);
		const list = card.createDiv({ cls: 'crate-get-started-steps' });
		for (const step of steps) {
			const row = list.createDiv({ cls: 'crate-get-started-step' });
			if (step.done) row.addClass('is-done');
			else if (step !== next) row.addClass('is-upcoming');
			setIcon(row.createSpan({ cls: 'crate-get-started-icon' }), step.done ? 'circle-check' : 'circle');
			const body = row.createDiv({ cls: 'crate-get-started-body' });
			body.createDiv({ cls: 'crate-get-started-name', text: step.name });
			if (step !== next) continue;
			body.createDiv({ cls: 'crate-get-started-desc', text: step.desc });
			if (step.action) addAction(row, step.name, step.action, true);
		}

		const suggestions = buildSuggestions(context);
		if (suggestions.length === 0) return;
		card.createDiv({ cls: 'crate-get-started-subtitle', text: 'Also try' });
		const extras = card.createDiv({ cls: 'crate-get-started-steps' });
		for (const suggestion of suggestions) {
			const row = extras.createDiv({ cls: 'crate-get-started-step is-suggestion' });
			const body = row.createDiv({ cls: 'crate-get-started-body' });
			body.createDiv({ cls: 'crate-get-started-name', text: suggestion.name });
			body.createDiv({ cls: 'crate-get-started-desc', text: suggestion.desc });
			if (suggestion.action) addAction(row, suggestion.name, suggestion.action, false);
		}
	};

	render();
	// A first sync from the status row or the command palette checks its step off here too.
	const onStateChange = () => { if (!disposed) render(); };
	plugin.syncRuntime.addStateChangeListener(onStateChange);
	if (devices === null) {
		void loadConnectedDevices(plugin).then(tokens => {
			if (disposed) return;
			devices = tokens;
			render();
		}).catch(() => { /* The device steps stay unchecked when the list cannot load. */ });
	}
	return () => {
		disposed = true;
		plugin.syncRuntime.removeStateChangeListener(onStateChange);
	};
}

function buildSteps({ containerEl, plugin }: SettingsSectionContext, devices: RegisteredDevice[] | null): GetStartedStep[] {
	const showFeatures = { label: 'Show', run: () => { openSettingsSection(containerEl, 'Features'); } };
	return [
		{
			name: 'Run your first sync',
			desc: 'Sync this vault with your server. Until automatic sync is on, Crate syncs only when you select Sync now.',
			done: Boolean(plugin.settings.lastSync),
			action: { label: 'Sync now', run: async () => {
				// The first sync is often the longest, so show its progress.
				new ActivityModal(plugin.app, plugin.settings, plugin.syncRuntime).open();
				try {
					const result = await plugin.syncRuntime.sync();
					if (result.outcome === 'cancelled') return;
					if (!result.success) showSyncErrorNotice(plugin, 'Sync completed with errors.');
					notifyConflicts(result.conflicts);
				} catch (error) {
					new Notice(`Sync failed: ${errorMessage(error)}`);
				}
			} },
		},
		{
			name: 'Add another device',
			desc: 'Sync this vault to Obsidian on your phone or another computer.',
			done: connectedDeviceKinds(devices).otherDevice,
			action: { label: 'Add a device', run: () => {
				if (canAddDeviceWithCode(plugin)) new AddDeviceModal(plugin).open();
				else openSettingsSection(containerEl, 'Account and devices');
			} },
		},
		{ name: 'Turn on reminders', desc: 'Keep reminders in your notes and get notified on your phone.', done: plugin.remindersSettings.enabled, action: showFeatures },
		{ name: 'Turn on Reading', desc: 'Save articles to read and highlight later.', done: plugin.settings.reading.enabled, action: showFeatures },
		{
			name: 'Install the web app',
			desc: 'Reminder notifications and Reading, from your home screen.',
			done: connectedDeviceKinds(devices).webApp,
			action: { label: 'Show code', run: async () => {
				try {
					new QRModal(plugin.app, await buildEnrollmentUrl(plugin)).open();
				} catch (error) {
					new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
				}
			} },
		},
	];
}

/** Optional extras. They never count toward setup and each disappears once it is on. */
function buildSuggestions({ plugin, rerender }: SettingsSectionContext): GetStartedStep[] {
	const suggestions: GetStartedStep[] = [
		{
			name: 'Automatic sync',
			desc: 'Sync after edits, on startup, and at an interval.',
			done: plugin.settings.automaticSync,
			action: { label: 'Turn on', run: async () => {
				try {
					await writeSyncSettings(plugin, { automaticSync: true });
					rerender();
				} catch (error) {
					new Notice(`Failed to save sync settings: ${errorMessage(error)}`);
				}
			} },
		},
	];
	return suggestions.filter(suggestion => !suggestion.done);
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
	if (!plugin.settings.getStartedDismissed || !plugin.syncRuntime.isConfigured()) return;
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
