import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import { QRModal } from '../qr-modal';
import { loadEncryptionKeys } from '../../plugin/encryption-storage';
import { SECRET_KEYS } from '../../plugin/settings-types';

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
	const tokenBefore = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
	const keys = loadEncryptionKeys(plugin.secretStorage);
	const recovery = keys ? plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) : null;
	if (keys && !recovery) throw new Error('Unlock this vault with your recovery key before connecting the web app.');
	const folder = plugin.remindersSettings.remindersFolderPath;
	const readingFolder = plugin.settings.reading.folderPath;
	const assertCurrent = () => {
		if (plugin.syncRuntime.getApiClient() !== apiClient || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== tokenBefore
			|| plugin.remindersSettings.remindersFolderPath !== folder || plugin.settings.reading.folderPath !== readingFolder
			|| (keys && plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) !== recovery)) {
			throw new Error('The connection changed. Create a new setup link.');
		}
	};

  if (plugin.settings.pushEnabled) {
    await apiClient.ensureNotificationPolicy({ folderPath: folder,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDayTime: plugin.remindersSettings.allDayNotificationTime });
  }
	assertCurrent();
	const { token, browserToken } = await apiClient.createRemindersEnrollmentToken(folder);
	assertCurrent();
	const subscribeUrl = new URL('notifications', `${apiClient.getWorkerUrl()}/`);
	if (keys && recovery) {
		const fragment = new URLSearchParams({ crateKey: recovery });
		if (keys.scopes.some(scope => scope.folderPath === readingFolder)) fragment.set('crateReadingKey', recovery);
		subscribeUrl.hash = fragment.toString();
	}
	subscribeUrl.searchParams.set('token', token);
	if (browserToken) subscribeUrl.searchParams.set('browserToken', browserToken);
	subscribeUrl.searchParams.set('folder', folder);
	subscribeUrl.searchParams.set('upcomingDays', String(plugin.remindersSettings.upcomingDaysDefault ?? 7));
	if (plugin.remindersSettings.allDayNotificationTime) {
		subscribeUrl.searchParams.set('allDayTime', plugin.remindersSettings.allDayNotificationTime);
	}
	return subscribeUrl.toString();
}
