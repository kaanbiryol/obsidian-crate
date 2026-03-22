import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';

export interface NotificationsSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderNotificationsSection(context: NotificationsSectionContext): void {
	const { containerEl, plugin } = context;

	containerEl.createEl('h3', { text: 'Notifications' });

	new Setting(containerEl)
		.setName('Enable ntfy notifications')
		.setDesc('Allow the reminders plugin to send push notifications via ntfy.sh')
		.addToggle(toggle => {
			toggle.setValue(plugin.settings.ntfyEnabled)
				.onChange(async (value) => {
					plugin.settings.ntfyEnabled = value;
					await plugin.saveSettings();
				});
		});

	new Setting(containerEl)
		.setName('ntfy topic')
		.setDesc('Your ntfy.sh topic name (e.g. "my-reminders-abc123")')
		.addText(text => {
			text.setPlaceholder('my-reminders-topic')
				.setValue(plugin.settings.ntfyTopic)
				.onChange(async (value) => {
					plugin.settings.ntfyTopic = value;
					await plugin.saveSettings();
				});
		});

	new Setting(containerEl)
		.setName('Test notification')
		.setDesc('Send a test notification to your ntfy topic')
		.addButton(button => {
			button.setButtonText('Send test');
			button.onClick(async () => {
				const topic = plugin.settings.ntfyTopic;
				if (!topic) {
					new Notice('Please set an ntfy topic first');
					return;
				}
				button.setButtonText('Sending...');
				button.setDisabled(true);
				try {
					const response = await fetch(`https://ntfy.sh/${topic}`, {
						method: 'POST',
						headers: { 'Title': 'Crate test notification', 'Tags': 'white_check_mark' },
						body: 'If you see this, ntfy notifications are working!',
					});
					new Notice(response.ok ? 'Test notification sent!' : 'Failed to send test notification');
				} catch {
					new Notice('Failed to send test notification');
				} finally {
					button.setButtonText('Send test');
					button.setDisabled(false);
				}
			});
		});
}
