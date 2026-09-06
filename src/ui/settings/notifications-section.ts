import { Notice, Setting, type TextComponent, type ToggleComponent } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import {
	enableReminderNotifications,
	reconcileReminderNotifications,
} from '../../reminders/plugin-integration';
import { normalizeTimeString } from '../../reminders/settings';
import type { NotificationPolicy } from '../../protocol/notification-policy';
import type { SyncApiClient } from '../../sync/api';
import { createSettingsSectionHeading } from './section-helpers';

export interface NotificationsSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderNotificationsSection(context: NotificationsSectionContext): void {
	const { containerEl, plugin } = context;

	createSettingsSectionHeading(containerEl, 'Push notifications');

  const policyApi = plugin.syncRuntime.getApiClient();
  let policy: NotificationPolicy | null = null;
  let loadError: unknown;
  const openedPolicy = policyApi ? policyApi.getNotificationPolicy().then(result => { policy = result.policy; }).catch(error => { loadError = error; }) : Promise.resolve();
  const savePolicy = async (patch: Partial<NotificationPolicy>) => {
    await openedPolicy;
    if (loadError) throw new Error(errorMessage(loadError));
    if (!policyApi) throw new Error('Connect to the sync server before changing notifications');
    const initial = { folderPath: plugin.remindersSettings.remindersFolderPath,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      allDayTime: plugin.remindersSettings.allDayNotificationTime, enabled: plugin.settings.pushEnabled };
    if (!policy) policy = (await policyApi.ensureNotificationPolicy(initial)).policy;
    // Even initialization can race another device. Apply explicit changes using
    // the server's returned revision and retain its timezone and folder.
    policy = (await policyApi.updateNotificationPolicy({ ...policy, ...patch })).policy;
  };
  let enabledToggle: ToggleComponent;
  new Setting(containerEl)
    .setName('Enable push notifications')
    .setDesc('Send reminder notifications to subscribed phones and browsers. Applies to all devices.')
    .addToggle(toggle => {
      enabledToggle = toggle;
      toggle.setValue(plugin.settings.pushEnabled).onChange(async value => {
        toggle.setDisabled(true);
        try {
          await savePolicy({ enabled: value });
          await plugin.writeSettings({ pushEnabled: value });
          if (value) await enableReminderNotifications(plugin);
          context.rerender();
        } catch (error) {
          new Notice(`Failed to save push notification settings: ${errorMessage(error)}`);
          toggle.setValue(policy?.enabled ?? plugin.settings.pushEnabled);
        } finally { toggle.setDisabled(false); }
      });
    });
  void openedPolicy.then(() => { if (policy) enabledToggle.setValue(policy.enabled !== false); });

  const saveAllDayTime = async (time: string | null) => {
    await savePolicy({ allDayTime: time });
    await plugin.writeRemindersSettings({ allDayNotificationTime: time });
  };
	let timeInput: TextComponent;
	new Setting(containerEl)
		.setName('All-day notification time')
		.setDesc('Shared across devices in the server’s saved timezone. An empty time means off.')
		.addText(text => {
			timeInput = text;
			text.inputEl.type = 'time';
			text.setValue(plugin.remindersSettings.allDayNotificationTime ?? '')
				.setPlaceholder('09:00');
			text.inputEl.maxLength = 5;

			const commit = async (): Promise<void> => {
				const trimmed = text.inputEl.value.trim();
				if (trimmed === '') {
					await saveAllDayTime(null);
					void reconcileReminderNotifications(plugin);
					return;
				}
				const normalized = normalizeTimeString(trimmed);
				if (normalized) {
					text.setValue(normalized);
					await saveAllDayTime(normalized);
					void reconcileReminderNotifications(plugin);
				} else {
					text.setValue(plugin.remindersSettings.allDayNotificationTime ?? '');
				}
			};

			text.inputEl.addEventListener('blur', () => {
				void commit().catch((error: unknown) => {
					new Notice(`Failed to save notification time: ${errorMessage(error)}`);
					text.setValue(plugin.remindersSettings.allDayNotificationTime ?? '');
				});
			});
			text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					text.inputEl.blur();
				}
			});
		})
		.addButton(button => button.setButtonText('Turn off').onClick(async () => {
			button.setDisabled(true);
			try {
				await saveAllDayTime(null);
				timeInput.setValue('');
				void reconcileReminderNotifications(plugin);
			} catch (error) {
				new Notice(`Failed to save notification time: ${errorMessage(error)}`);
			} finally {
				button.setDisabled(false);
			}
		}));

  void openedPolicy.then(() => { if (policy) timeInput.setValue(policy.allDayTime ?? ''); });
  const policyDescription = containerEl.createEl('p', { cls: 'setting-item-description' });
  void openedPolicy.then(() => {
    policyDescription.textContent = loadError ? 'Shared settings could not be loaded. Reopen settings to retry.'
      : policy ? `Server notifications: ${policy.folderPath} · ${policy.timezone}` : 'The first enabled device saves the shared folder and timezone.';
  });
  new Setting(containerEl).setName('Notification folder and timezone')
    .setDesc('Use this device’s reminders folder and timezone for notifications on all devices.')
    .addButton(button => button.setButtonText('Use this device’s settings').onClick(async () => {
      button.setDisabled(true);
      try {
        await savePolicy({ folderPath: plugin.remindersSettings.remindersFolderPath, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        context.rerender();
      } catch (error) { new Notice(`Failed to save shared settings: ${errorMessage(error)}`); }
      finally { button.setDisabled(false); }
    }));
	const apiClient = plugin.syncRuntime.getApiClient();
	if (apiClient) renderEnabledDevices(containerEl, plugin, apiClient);
}

function renderEnabledDevices(containerEl: HTMLElement, plugin: CratePlugin, apiClient: SyncApiClient): void {
	const devicesContainer = containerEl.createDiv({ cls: 'crate-push-devices' });
	let listContainer: HTMLElement | null = null;

	new Setting(devicesContainer)
		.setName('Notification devices')
		.setDesc('Phones and browsers set up to receive reminder push notifications.')
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
		.setDesc('Send a test notification to all enabled devices.')
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
					button.setDestructive();
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
