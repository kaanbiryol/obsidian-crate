import { Notice, Platform, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { errorMessage } from '../../platform/logger';
import { QRModal } from '../qr-modal';
import { openExternalBrowserModal } from '../external-browser-modal';
import { loadEncryptionKeys } from '../../sync/encryption/key-storage';
import { SECRET_KEYS } from '../../platform/secret-keys';
import type { SettingsSectionContext } from './section-helpers';

const CONNECTION_CHANGED = 'The connection changed. Create a new setup link.';

export function renderCrateWebApp({ containerEl, plugin }: Omit<SettingsSectionContext, 'rerender'>): void {
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
					const url = await buildEnrollmentUrl(plugin);
					// Mobile webviews can block window.open once the tap's gesture has passed.
					if (Platform.isMobile) {
						openExternalBrowserModal(plugin.app, url, {
							title: 'Open Crate web app',
							message: 'Select the link below to open the web app in your browser.',
							linkText: 'Open app',
						});
					} else window.open(url, '_blank', 'noopener,noreferrer');
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
	if (!plugin.syncRuntime.getApiClient()) {
		throw new Error('Sync API is unavailable');
	}
	const tokenBefore = plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN);
	const keys = loadEncryptionKeys(plugin.secretStorage);
	const recovery = keys ? plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) : null;
	if (keys && !recovery) throw new Error('Unlock this vault with your recovery key before connecting the web app.');
	const folder = plugin.remindersSettings.remindersFolderPath;
	const readingFolder = plugin.settings.reading.folderPath;
	return plugin.syncRuntime.withCurrentApi(async (apiClient, isCurrentApi) => {
		const assertCurrent = () => {
			if (!isCurrentApi() || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== tokenBefore
				|| plugin.remindersSettings.remindersFolderPath !== folder || plugin.settings.reading.folderPath !== readingFolder
				|| (keys && plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY) !== recovery)) {
				throw new Error(CONNECTION_CHANGED);
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
			// Reminders and Reading unlock independently at launch, from the same recovery key.
			// The fragment never reaches the server, so the folder's plaintext name can travel with the key.
			subscribeUrl.hash = new URLSearchParams({ crateKey: recovery, crateReadingKey: recovery, crateFolder: folder }).toString();
		}
		subscribeUrl.searchParams.set('token', token);
		if (browserToken) subscribeUrl.searchParams.set('browserToken', browserToken);
		if (!keys) subscribeUrl.searchParams.set('folder', folder);
		subscribeUrl.searchParams.set('upcomingDays', String(plugin.remindersSettings.upcomingDaysDefault ?? 7));
		if (plugin.remindersSettings.allDayNotificationTime) {
			subscribeUrl.searchParams.set('allDayTime', plugin.remindersSettings.allDayNotificationTime);
		}
		return subscribeUrl.toString();
	}, CONNECTION_CHANGED);
}
