import { setReminderRibbon } from './visibility';
import { addIcon, type MarkdownPostProcessorContext } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { registerReminderCommands } from './commands';
import { ReminderQueryInjector } from './query/injector';
import { RemindersView, VIEW_TYPE_REMINDERS } from './ui/plugin/reminders-view';
import { createLogger } from './logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { CRATE_ICON_ID, CRATE_ICON_SVG } from '../ui/crate-icon';

const remindersLogger = createLogger('Reminders');
const registeredReminderUi = new WeakSet<CratePlugin>();

export async function registerReminderIntegrations(plugin: CratePlugin, openView: () => Promise<void>): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (registeredReminderUi.has(plugin)) {
		return;
	}
	registeredReminderUi.add(plugin);

	const queryProcessor = new ReminderQueryInjector(plugin);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onBlock('reminders', source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-today',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onBlock('reminders-today', source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-upcoming',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onBlock('reminders-upcoming', source, el, ctx),
	);

	addIcon(CRATE_ICON_ID, CRATE_ICON_SVG);
	plugin.registerView(
		VIEW_TYPE_REMINDERS,
		(leaf) => new RemindersView(leaf, plugin),
	);
	const ribbon = plugin.addRibbonIcon(CRATE_ICON_ID, 'Open Crate', () => {
		void openView();
	});

	setReminderRibbon(plugin, ribbon);
	registerReminderCommands(plugin);

	plugin.addCommand({
		id: 'open-reminders-view',
		name: 'Open sidebar',
		callback: () => openView(),
	});

	if (plugin.remindersSettings.autoOpenView !== 'none') {
		let opening: Promise<void> | undefined;
		plugin.app.workspace.onLayoutReady(() => {
			if (signal.aborted) return;
			if (plugin.remindersSettings.autoOpenView === 'sidebar') {
				opening = openView();
				void opening.catch(error => remindersLogger.error('Failed to open reminders:', error));
			}
		});
		// When the workspace is already ready (including plugin reload), finish
		// constructing/revealing this view before the plugin load completes.
		await opening;
	}
}
