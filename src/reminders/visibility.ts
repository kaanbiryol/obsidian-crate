import type CratePlugin from '../plugin/CratePlugin';

const ribbons = new WeakMap<CratePlugin, HTMLElement>();
export function setReminderRibbon(plugin: CratePlugin, ribbon: HTMLElement): void {
	ribbons.set(plugin, ribbon);
	updateReminderVisibility(plugin);
}
export function updateReminderVisibility(plugin: CratePlugin): void {
	const ribbon = ribbons.get(plugin);
	if (ribbon) ribbon.hidden = !plugin.remindersSettings.enabled;
}
