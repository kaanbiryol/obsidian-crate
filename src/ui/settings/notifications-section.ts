import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { reconcileReminderNotifications } from '../../reminders/plugin-integration';
import { normalizeTimeString } from '../../reminders/settings';
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
			.setName('Subscribe a device')
			.setDesc('Open this link on your phone or scan the code to enable notifications on that device. Each link expires shortly, works once after a successful subscription, and does not expose your sync token.')
			.addButton(button => {
				button.setButtonText('Copy link');
				button.onClick(async () => {
					try {
						const url = await buildEnrollmentUrl(plugin);
						await navigator.clipboard.writeText(url);
						new Notice('Subscribe link copied to clipboard');
					} catch {
						new Notice('Failed to create subscribe link');
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
						new Notice('Failed to create subscribe code');
					}
				});
			});

		// Subscriptions list
		const listContainer = containerEl.createDiv({ cls: 'crate-push-subscriptions' });
		void loadSubscriptions(listContainer, plugin);

		// Test button
		new Setting(containerEl)
			.setName('Test notification')
			.setDesc('Send a test push to all subscribed devices')
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
							new Notice('No subscribed devices found. Subscribe a device first.');
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
}

async function buildEnrollmentUrl(plugin: CratePlugin): Promise<string> {
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) {
		throw new Error('Sync API is unavailable');
	}

	const { token } = await apiClient.createPushEnrollmentToken();
	const subscribeUrl = new URL('notifications', `${plugin.settings.workerUrl}/`);
	subscribeUrl.searchParams.set('token', token);
	return subscribeUrl.toString();
}

async function loadSubscriptions(container: HTMLElement, plugin: CratePlugin): Promise<void> {
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) return;

	try {
		const { subscriptions } = await apiClient.getPushSubscriptions();

		if (subscriptions.length === 0) {
			container.createEl('p', {
				text: 'No devices subscribed yet.',
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
