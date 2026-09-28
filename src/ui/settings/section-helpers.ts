import { Setting } from 'obsidian';

export function createSettingsSectionHeading(containerEl: HTMLElement, title: string): Setting {
	return new Setting(containerEl)
		.setName(title)
		.setHeading()
		.setClass('crate-settings-section-heading');
}

export function createSettingsSubsectionHeading(containerEl: HTMLElement, title: string): Setting {
	return new Setting(containerEl)
		.setName(title)
		.setHeading()
		.setClass('crate-settings-subsection-heading');
}

export function createSettingsDisclosure(containerEl: HTMLElement, title: string, options: {
	summary?: string;
	onOpen?: (content: HTMLElement) => void;
} = {}): HTMLElement {
	const details = containerEl.createEl('details', { cls: 'crate-settings-disclosure' });
	details.setAttribute('data-settings-section', title);
	const summary = details.createEl('summary');
	summary.createSpan({ text: title });
	if (options.summary) summary.createSpan({ text: options.summary, cls: 'crate-settings-disclosure-summary' });
	const content = details.createDiv();
	if (options.onOpen) {
		let initialized = false;
		details.addEventListener('toggle', () => {
			if (!details.isConnected || !details.open || initialized) return;
			initialized = true;
			options.onOpen?.(content);
		});
	}
	return content;
}
