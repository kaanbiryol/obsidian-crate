import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import { QRModal } from '../qr-modal';
import { loadEncryptionKeys } from '../../plugin/encryption-storage';
import { createReminderKeyGrant } from '../../encryption/key-bundle';
import { encodeWebAppKey } from '../../encryption/web-app-key';

export function renderCrateWebApp(containerEl: HTMLElement, plugin: CratePlugin): void {
	if (!plugin.syncRuntime.getApiClient()) return;
	new Setting(containerEl)
		.setName('Crate web app')
		.setDesc('Open here, or connect another device with a QR code or setup link.')
		.setClass('crate-web-app-setting')
		.addButton(button => {
			button.setButtonText('Open app');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					window.open(await buildEnrollmentUrl(plugin), '_blank', 'noopener,noreferrer');
				} catch (error) {
					new Notice(`Could not create app link: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Open app');
					button.setDisabled(false);
				}
			});
		})
		.addButton(button => {
			button.setButtonText('Connect another device');
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					const url = await buildEnrollmentUrl(plugin);
					new QRModal(plugin.app, url).open();
				} catch (error) {
					new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
				} finally {
					button.setButtonText('Connect another device');
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
	const keys = loadEncryptionKeys(plugin.secretStorage);
	if (keys) {
		const fragment = new URLSearchParams({ crateKey: encodeWebAppKey([createReminderKeyGrant(keys, plugin.remindersSettings.remindersFolderPath)]) });
		if (keys.scopes.some(scope => scope.folderPath === plugin.settings.reading.folderPath)) fragment.set('crateReadingKey', encodeWebAppKey([createReminderKeyGrant(keys, plugin.settings.reading.folderPath)]));
		subscribeUrl.hash = fragment.toString();
	}
	subscribeUrl.searchParams.set('token', token);
	if (browserToken) subscribeUrl.searchParams.set('browserToken', browserToken);
	subscribeUrl.searchParams.set('folder', plugin.remindersSettings.remindersFolderPath);
	subscribeUrl.searchParams.set('upcomingDays', String(plugin.remindersSettings.upcomingDaysDefault ?? 7));
	if (plugin.remindersSettings.allDayNotificationTime) {
		subscribeUrl.searchParams.set('allDayTime', plugin.remindersSettings.allDayNotificationTime);
	}
	return subscribeUrl.toString();
}
