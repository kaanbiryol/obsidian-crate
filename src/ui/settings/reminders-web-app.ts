import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import { QRModal } from '../qr-modal';

export function renderRemindersWebApp(containerEl: HTMLElement, plugin: CratePlugin): void {
	if (!plugin.syncRuntime.getApiClient()) return;
	new Setting(containerEl)
		.setName('Reminders web app')
		.setDesc('Create a short-lived link to open your reminders on another device. You can enable notifications in the web app.')
		.addButton(button => {
			button.setButtonText('Copy app link');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					const url = await buildEnrollmentUrl(plugin);
					await navigator.clipboard.writeText(url);
					new Notice('App link copied to clipboard');
				} catch (error) {
					new Notice(`Could not create app link: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Copy app link');
					button.setDisabled(false);
				}
			});
		})
		.addButton(button => {
			button.setButtonText('Show code');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					const url = await buildEnrollmentUrl(plugin);
					new QRModal(plugin.app, url).open();
				} catch (error) {
					new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Show code');
					button.setDisabled(false);
				}
			});
		});
}

async function buildEnrollmentUrl(plugin: CratePlugin): Promise<string> {
	const apiClient = plugin.syncRuntime.getApiClient();
	if (!apiClient) {
		throw new Error('Sync API is unavailable');
	}

  if (plugin.settings.pushEnabled) {
    await apiClient.ensureNotificationPolicy({ folderPath: plugin.remindersSettings.remindersFolderPath,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDayTime: plugin.remindersSettings.allDayNotificationTime });
  }
	const { token, browserToken } = await apiClient.createRemindersEnrollmentToken(plugin.remindersSettings.remindersFolderPath);
	const subscribeUrl = new URL('notifications', `${apiClient.getWorkerUrl()}/`);
	subscribeUrl.searchParams.set('token', token);
	if (browserToken) subscribeUrl.searchParams.set('browserToken', browserToken);
	subscribeUrl.searchParams.set('folder', plugin.remindersSettings.remindersFolderPath);
	subscribeUrl.searchParams.set('upcomingDays', String(plugin.remindersSettings.upcomingDaysDefault ?? 7));
	if (plugin.remindersSettings.allDayNotificationTime) {
		subscribeUrl.searchParams.set('allDayTime', plugin.remindersSettings.allDayNotificationTime);
	}
	return subscribeUrl.toString();
}
