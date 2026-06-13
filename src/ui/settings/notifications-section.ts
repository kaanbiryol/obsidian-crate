import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { reconcileReminderNotifications } from '../../reminders/plugin-integration';
import { normalizeTimeString } from '../../reminders/settings';
import type { SyncApiClient } from '../../sync/api';
import { QRModal } from '../qr-modal';
import { createSettingsSectionHeading } from './section-helpers';

export interface NotificationsSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderNotificationsSection(context: NotificationsSectionContext): void {
	const { containerEl, plugin } = context;

	createSettingsSectionHeading(containerEl, 'Push notifications');

	new Setting(containerEl)
		.setName('Enable push notifications')
		.setDesc('Send push notifications for reminders')
		.addToggle(toggle => {
			toggle.setValue(plugin.settings.pushEnabled)
				.onChange(async (value) => {
					plugin.settings.pushEnabled = value;
					await plugin.saveSettings();
					context.rerender();
				});
		});

	if (!plugin.settings.pushEnabled) return;

	new Setting(containerEl)
		.setName('All-day reminder notification time')
		.setDesc('Send notifications for date-only reminders at this time (24h format, e.g. 09:00)')
		.addText(text => {
			text.setValue(plugin.remindersSettings.allDayNotificationTime ?? '')
				.setPlaceholder('09:00');
			text.inputEl.maxLength = 5;

			const commit = async (): Promise<void> => {
				const trimmed = text.inputEl.value.trim();
				if (trimmed === '') {
					await plugin.writeRemindersSettings({ allDayNotificationTime: null });
					void reconcileReminderNotifications(plugin);
					return;
				}
				const normalized = normalizeTimeString(trimmed);
				if (normalized) {
					text.setValue(normalized);
					await plugin.writeRemindersSettings({ allDayNotificationTime: normalized });
					void reconcileReminderNotifications(plugin);
				} else {
					text.setValue(plugin.remindersSettings.allDayNotificationTime ?? '');
				}
			};

			text.inputEl.addEventListener('blur', () => void commit());
			text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					text.inputEl.blur();
				}
			});
		});

	// Subscribe link + QR code
	const apiClient = plugin.syncRuntime.getApiClient();
	if (apiClient) {
		new Setting(containerEl)
			.setName('Reminders web app')
			.setDesc('Create a short-lived link for opening reminders on another device. The web app can enable push notifications from that device after it opens.')
			.addButton(button => {
				button.setButtonText('Copy app link');
				button.onClick(async () => {
					try {
						const url = await buildEnrollmentUrl(plugin);
						await navigator.clipboard.writeText(url);
						new Notice('App link copied to clipboard');
					} catch {
						new Notice('Failed to create app link');
					}
				});
			})
			.addButton(button => {
				button.setButtonText('Show code');
				button.onClick(async () => {
					try {
						const url = await buildEnrollmentUrl(plugin);
						new QRModal(plugin.app, url).open();
					} catch {
						new Notice('Failed to create app code');
					}
				});
			});

		renderEnabledDevices(containerEl, plugin, apiClient);
	}
}

async function buildEnrollmentUrl(plugin: CratePlugin): Promise<string> {
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) {
		throw new Error('Sync API is unavailable');
	}

	const { token } = await apiClient.createRemindersEnrollmentToken();
	const subscribeUrl = new URL('notifications', `${plugin.settings.workerUrl}/`);
	subscribeUrl.searchParams.set('token', token);
	subscribeUrl.searchParams.set('folder', plugin.remindersSettings.remindersFolderPath);
	subscribeUrl.searchParams.set('upcomingDays', String(plugin.remindersSettings.upcomingDaysDefault ?? 7));
	if (plugin.remindersSettings.allDayNotificationTime) {
		subscribeUrl.searchParams.set('allDayTime', plugin.remindersSettings.allDayNotificationTime);
	}
	return subscribeUrl.toString();
}

function renderEnabledDevices(containerEl: HTMLElement, plugin: CratePlugin, apiClient: SyncApiClient): void {
	const devicesContainer = containerEl.createDiv({ cls: 'crate-push-devices' });
	let listContainer: HTMLElement | null = null;

	new Setting(devicesContainer)
		.setName('Enabled devices')
		.setDesc('Phones and browsers currently registered to receive reminder push notifications.')
		.addButton(button => {
			button.setButtonText('Refresh');
			button.onClick(async () => {
				if (listContainer) {
					await loadSubscriptions(listContainer, plugin);
				}
			});
		});

	listContainer = devicesContainer.createDiv({ cls: 'crate-push-subscriptions' });
	void loadSubscriptions(listContainer, plugin);

	new Setting(devicesContainer)
		.setName('Test notification')
		.setDesc('Send a test push to all enabled devices')
		.addButton(button => {
			button.setButtonText('Send test');
			button.onClick(async () => {
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
					button.setButtonText('Send test');
					button.setDisabled(false);
				}
			});
		});
}

async function loadSubscriptions(container: HTMLElement, plugin: CratePlugin): Promise<void> {
	container.empty();
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) return;

	try {
		const { subscriptions } = await apiClient.getPushSubscriptions();

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
				.setDesc(`Subscribed ${new Date(sub.created_at).toLocaleDateString()}`)
				.addButton(button => {
					button.setButtonText('Remove');
					button.setWarning();
					button.onClick(async () => {
						try {
							await apiClient.deletePushSubscription(sub.id);
							container.empty();
							await loadSubscriptions(container, plugin);
						} catch {
							new Notice('Failed to remove subscription');
						}
					});
				});
		}
	} catch {
		container.createEl('p', {
			text: 'Failed to load subscriptions.',
			cls: 'setting-item-description',
		});
	}
}
