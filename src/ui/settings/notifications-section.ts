import { Notice, Setting, type TextComponent, type ToggleComponent, type ButtonComponent } from 'obsidian';
import { createSettingsDisclosure } from '../plugin/settings-disclosure';
import type CratePlugin from '../../plugin/CratePlugin';
import { errorMessage } from '../../platform/logger';
import { parseServerTimestamp } from '../shared/format';
import { openConfirmationModal } from '../plugin/confirmation-modal';
import { normalizeTimeString } from '../../platform/validation';
import { openNotificationPolicy } from '../../reminders/notification-policy-sync';
import type { SyncApiClient } from '../../sync/worker-api/client';
import type { SettingsSectionContext } from './section-helpers';
import { bindCommittedText } from './input-helpers';

export function renderNotificationsSection(context: SettingsSectionContext): () => void {
	const { containerEl, plugin } = context;
	let active = true;
	const isActive = () => active;
	const opened = openNotificationPolicy(plugin);
	const content = createSettingsDisclosure(containerEl, 'Notifications', {
		summary: plugin.settings.pushEnabled ? 'On · schedule, timezone, and devices' : 'Off',
		onOpen: notificationContent => {
			if (!active) return;
			let enabledToggle: ToggleComponent;
			new Setting(notificationContent)
				.setName('Push notifications')
				.setDesc('All devices · send reminder notifications to subscribed phones and browsers.')
				.addToggle(toggle => {
					enabledToggle = toggle;
					toggle.setValue(plugin.settings.pushEnabled).onChange(async value => {
						toggle.setDisabled(true);
						try {
							await opened.save({ enabled: value });
							await plugin.writeSettings({ pushEnabled: value }, opened.assertCurrent);
							if (active) context.rerender();
						} catch (error) {
							new Notice(`Failed to save push notification settings: ${errorMessage(error)}`);
							toggle.setValue(opened.policy?.enabled ?? plugin.settings.pushEnabled);
						} finally { toggle.setDisabled(false); }
					});
				});

			const options = notificationContent.createDiv();
			options.hidden = !plugin.settings.pushEnabled;
			const saveAllDayTime = async (time: string | null) => {
				await opened.save({ allDayTime: time });
				await plugin.writeRemindersSettings({ allDayNotificationTime: time }, opened.assertCurrent);
			};
			let timeInput: TextComponent;
			const timeSetting = new Setting(options)
				.setName('All-day notification time')
				.setDesc('All devices · loading the notification timezone…')
				.addText(text => {
					timeInput = text;
					text.inputEl.type = 'time';
					text.setValue(plugin.remindersSettings.allDayNotificationTime ?? '')
						.setPlaceholder('09:00');
					text.inputEl.maxLength = 5;
					// The field shows the shared policy's time once it loads. An empty time means off.
					bindCommittedText(text, () => (opened.policy ? opened.policy.allDayTime : plugin.remindersSettings.allDayNotificationTime) ?? '',
						value => saveAllDayTime(value ? normalizeTimeString(value) : null),
						value => value === '' || normalizeTimeString(value) !== null,
						error => `Failed to save notification time: ${errorMessage(error)}`);
				})
				.addButton(button => button.setButtonText('Turn off').onClick(async () => {
					button.setDisabled(true);
					try {
						await saveAllDayTime(null);
						timeInput.setValue('');
					} catch (error) {
						new Notice(`Failed to save notification time: ${errorMessage(error)}`);
					} finally {
						button.setDisabled(false);
					}
				}));

			const policyDescription = options.createEl('p', { cls: 'setting-item-description' });
			void opened.loaded.then(() => {
				if (!active) return;
				const { policy, loadError } = opened;
				if (policy) enabledToggle.setValue(policy.enabled !== false);
				if (!loadError) options.hidden = !(policy?.enabled ?? plugin.settings.pushEnabled);
				if (policy) timeInput.setValue(policy.allDayTime ?? '');
				timeSetting.setDesc(loadError
					? 'Could not load the notification timezone. Reopen settings to retry.'
					: `All devices · timezone: ${policy?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}. An empty time means off.`);
				policyDescription.textContent = loadError ? 'Shared settings could not be loaded. Reopen settings to retry.'
					: policy ? `Server notifications: ${policy.folderPath} · ${policy.timezone}` : 'The first enabled device saves the shared folder and timezone.';
			});
			new Setting(options).setName('Notification folder and timezone')
				.setDesc(`All devices · set the notification folder to ${plugin.remindersSettings.remindersFolderPath} and timezone to ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`)
				.addButton(button => button.setButtonText('Use this device’s settings').onClick(async () => {
					button.setDisabled(true);
					try {
						await opened.save({ folderPath: plugin.remindersSettings.remindersFolderPath, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
						if (active) context.rerender();
					} catch (error) { new Notice(`Failed to save shared settings: ${errorMessage(error)}`); }
					finally { button.setDisabled(false); }
				}));
			if (opened.api) renderEnabledDevices(options, plugin, opened.api, isActive);
		},
	});
	void opened.loaded.then(() => {
		if (!active || opened.loadError) return;
		const summary = content.parentElement?.querySelector('.crate-settings-disclosure-summary');
		if (summary) summary.textContent = (opened.policy?.enabled ?? plugin.settings.pushEnabled)
			? 'On · schedule, timezone, and devices' : 'Off';
	});

	return () => { active = false; };
}

function renderEnabledDevices(containerEl: HTMLElement, plugin: CratePlugin, apiClient: SyncApiClient, isActive: () => boolean): void {
	const devicesContainer = containerEl.createDiv({ cls: 'crate-push-devices' });
	let listContainer: HTMLElement | null = null;
	let testButton: ButtonComponent;
	let enabledCount = 0;
	let requestRevision = 0;
	const refresh = async () => {
		const revision = ++requestRevision;
		if (!listContainer || !isActive()) return;
		testButton?.setDisabled(true);
		await loadSubscriptions(listContainer, plugin, apiClient, () => isActive() && revision === requestRevision, count => {
			enabledCount = count;
			testButton.setDisabled(count === 0);
		}, refresh);
	};

	new Setting(devicesContainer)
		.setName('Notification devices')
		.setDesc('Phones and browsers set up to receive reminder push notifications.')
		.addButton(button => {
			button.setButtonText('Refresh');
			button.onClick(async () => {
				if (listContainer) {
					await refresh();
				}
			});
		});

	listContainer = devicesContainer.createDiv({ cls: 'crate-push-subscriptions' });
	void refresh();

	new Setting(devicesContainer)
		.setName('Test notification')
		.setDesc('Send a test notification to all enabled devices.')
		.addButton(button => {
			testButton = button.setButtonText('Send test').setDisabled(enabledCount === 0);
			button.onClick(async () => {
				if (!enabledCount || !isActive()) return;
				button.setButtonText('Sending...');
				button.setDisabled(true);
				try {
					const result = await apiClient.testPush();
					if (result.sent > 0) {
						new Notice(`Test sent to ${result.sent} device(s)`);
					} else if (result.errors?.length) {
						new Notice(`Push failed: ${result.errors.join('; ')}`, 10000);
					} else {
						new Notice('No enabled devices found. Enable notifications in the web app first.');
					}
				} catch {
					new Notice('Failed to send test notification');
				} finally {
					if (isActive()) button.setButtonText('Send test').setDisabled(enabledCount === 0);
				}
			});
		});
}

async function loadSubscriptions(container: HTMLElement, plugin: CratePlugin, apiClient: SyncApiClient, isActive: () => boolean, onCount: (count: number) => void, refresh: () => Promise<void>): Promise<void> {
	try {
		const { subscriptions } = await apiClient.getPushSubscriptions();
		if (!isActive()) return;
		container.empty();
		onCount(subscriptions.filter(subscription => !subscription.disabled_at).length);

		if (subscriptions.length === 0) {
			container.createEl('p', {
				text: 'No enabled devices yet. Open the reminders web app on a device and enable notifications there.',
				cls: 'setting-item-description',
			});
			return;
		}

		for (const sub of subscriptions) {
			new Setting(container)
				.setName(sub.device_name || 'Unknown device')
				.setDesc(sub.disabled_at
					? 'Notifications paused. Remove this device, sign out in its web app, then open a fresh Crate link to enable notifications again.'
					: `Subscribed ${parseServerTimestamp(sub.created_at).toLocaleDateString()}`)
				.addButton(button => {
					button.setButtonText('Remove notification subscription');
					button.setDestructive();
					button.onClick(async () => {
						const confirmed = await openConfirmationModal(plugin.app, {
							title: 'Remove notification subscription',
							message: `Stop sending reminder notifications to ${sub.device_name || 'this device'}?`,
							confirmText: 'Remove',
							warning: true,
						});
						if (!confirmed || !isActive()) return;
						try {
							await apiClient.deletePushSubscription(sub.id);
							container.empty();
							await refresh();
						} catch (error) {
							new Notice(`Failed to remove subscription: ${errorMessage(error)}`);
						}
					});
				});
		}
	} catch {
		if (!isActive()) return;
		container.empty();
		onCount(0);
		container.createEl('p', {
			text: 'Failed to load subscriptions.',
			cls: 'setting-item-description',
		});
	}
}
