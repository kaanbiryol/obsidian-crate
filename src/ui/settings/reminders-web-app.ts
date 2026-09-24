import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import { QRModal } from '../qr-modal';
import { openExternalBrowserModal } from '../external-browser-modal';

export function renderRemindersWebApp(containerEl: HTMLElement, plugin: CratePlugin): void {
	if (!plugin.syncRuntime.getApiClient()) return;
	new Setting(containerEl)
		.setName('Reminders web app')
		.setDesc('Create a short-lived link to open your reminders on your device. You can enable notifications in the web app.')
		.setClass('crate-web-app-setting')
		.addButton(button => {
			button.setButtonText('Copy app link');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					const url = await buildEnrollmentUrl(plugin);
					try {
						await navigator.clipboard.writeText(url);
						new Notice('App link copied to clipboard');
					} catch {
						showAppLink(plugin, url, true);
					}
				} catch (error) {
					new Notice(`Could not create app link: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Copy app link');
					button.setDisabled(false);
				}
			});
		})
		.addButton(button => {
			button.setButtonText('Show QR code');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					const url = await buildEnrollmentUrl(plugin);
					new QRModal(plugin.app, url).open();
				} catch (error) {
					new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Show QR code');
					button.setDisabled(false);
				}
			});
		})
		.addButton(button => {
			button.setButtonText('Open app');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					showAppLink(plugin, await buildEnrollmentUrl(plugin));
				} catch (error) {
					new Notice(`Could not create app link: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Open app');
					button.setDisabled(false);
				}
			});
		});
}

function showAppLink(plugin: CratePlugin, url: string, showCopyableUrl = false): void {
	openExternalBrowserModal(plugin.app, url, {
		title: 'Open reminders web app',
		message: showCopyableUrl
			? 'Select the link to open reminders, or select the text to copy it.'
			: 'Select the link below to open reminders in your browser.',
		linkText: 'Open reminders',
		showCopyableUrl,
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
