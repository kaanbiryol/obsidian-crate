import { Notice, Platform, Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import { errorMessage } from '../../platform/logger';
import { QRModal } from './qr-modal';
import { openExternalBrowserModal } from './external-browser-modal';
import { buildEnrollmentUrl } from '../../plugin/web-app-enrollment';
import { runButtonTask } from './action-helpers';
import type { SettingsSectionContext } from './section-helpers';

export function renderCrateWebApp({ containerEl, plugin }: Omit<SettingsSectionContext, 'rerender'>): void {
	if (!plugin.syncRuntime.getApiClient()) return;
	new Setting(containerEl)
		.setName('Crate web app')
		.setDesc('Open here, or connect another device with a QR code or setup link.')
		.setClass('crate-web-app-setting')
		.addButton(button => {
			button.setButtonText('Open app');
			button.onClick(() => runButtonTask({
				button, idleText: 'Open app', runningText: 'Creating...',
				task: () => buildEnrollmentUrl(plugin),
				onSuccess: url => {
					// Mobile webviews can block window.open once the tap's gesture has passed.
					if (Platform.isMobile) {
						openExternalBrowserModal(plugin.app, url, {
							title: 'Open Crate web app',
							message: 'Select the link below to open the web app in your browser.',
							linkText: 'Open app',
						});
					} else window.open(url, '_blank', 'noopener,noreferrer');
				},
				onError: error => { new Notice(`Could not create app link: ${errorMessage(error)}`, 10000); },
			}));
		})
		.addButton(button => {
			button.setButtonText('Connect another device');
			button.onClick(() => runButtonTask({
				button, idleText: 'Connect another device', runningText: 'Creating...',
				task: () => showWebAppCode(plugin),
			}));
		});
}

/** Opens the QR code and setup link for another device; a failure shows a notice. */
export async function showWebAppCode(plugin: CratePlugin): Promise<void> {
	try {
		new QRModal(plugin.app, await buildEnrollmentUrl(plugin)).open();
	} catch (error) {
		new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
	}
}
