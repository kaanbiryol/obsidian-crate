import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { QRModal } from '../qr-modal';
import { SECRET_KEYS } from '../../plugin/types';
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

	if (!plugin.syncRuntime.isConfigured()) {
		containerEl.createEl('p', {
			text: 'Set up sync first to enable push notifications.',
			cls: 'setting-item-description',
		});
		return;
	}

	// Subscribe link + QR code
	const apiClient = plugin.syncRuntime.getApiClient();
	if (apiClient) {
		const subscribeUrl = `${plugin.settings.workerUrl}/notifications`;
		const authToken = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '';

		new Setting(containerEl)
			.setName('Subscribe a device')
			.setDesc('Open this link on your phone or scan the code to enable notifications on that device.')
			.addButton(button => {
				button.setButtonText('Copy link');
				button.onClick(async () => {
					const url = `${subscribeUrl}?token=${authToken}`;
					await navigator.clipboard.writeText(url);
					new Notice('Subscribe link copied to clipboard');
				});
			})
			.addButton(button => {
				button.setButtonText('Show code');
				button.onClick(async () => {
					const url = `${subscribeUrl}?token=${authToken}`;
					new QRModal(plugin.app, url).open();
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
