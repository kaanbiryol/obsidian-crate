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
		.setDesc(Platform.isMobile
			? 'Open it in your browser, or scan a QR code to set it up on another device.'
			: 'Open it in your browser, or scan a QR code to set it up on your phone.')
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
			const label = webAppSetupLabel();
			button.setButtonText(label);
			button.onClick(() => runButtonTask({
				button, idleText: label, runningText: 'Creating...',
				task: () => showWebAppCode(plugin),
			}));
		});
}

/** Obsidian mobile is already on a phone, so it points at another device instead. */
function webAppSetupLabel(): string {
	return Platform.isMobile ? 'Set up on another device' : 'Set up on phone';
}

/** Opens the QR code and setup link for a phone or other device; a failure shows a notice. */
export async function showWebAppCode(plugin: CratePlugin): Promise<void> {
	try {
		new QRModal(plugin.app, await buildEnrollmentUrl(plugin), webAppSetupLabel()).open();
	} catch (error) {
		new Notice(`Could not create app code: ${errorMessage(error)}`, 10000);
	}
}
