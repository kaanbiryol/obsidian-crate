import { Platform, type ButtonComponent, type Setting } from 'obsidian';

/** Adds a server-changing button, or on mobile, where server changes do not run,
 * a note pointing to the desktop. */
export function addServerChangeButton(setting: Setting, configure: (button: ButtonComponent) => unknown): Setting {
	if (!Platform.isMobile) return setting.addButton(button => { configure(button); });
	setting.descEl.createDiv({ text: 'Available in Obsidian on a desktop.' });
	return setting;
}
