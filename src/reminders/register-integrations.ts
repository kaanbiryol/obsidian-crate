import type { MarkdownPostProcessorContext } from 'obsidian';
import type CratePlugin from '../main';
import { registerReminderCommands } from './commands';
import { ReminderQueryInjector } from './query/injector';
import { createRemindersBlockExtension } from './query/remindersBlockLivePreview';
import { openFullScreenReminderModal } from './ui/adapters/modals';
import { RemindersView, VIEW_TYPE_REMINDERS } from './ui/adapters/reminders-view';
import { createLogger } from './utils/logger';

const remindersLogger = createLogger('Reminders');
const registeredReminderUi = new WeakSet<CratePlugin>();

export function registerReminderIntegrations(plugin: CratePlugin): void {
	if (registeredReminderUi.has(plugin)) {
		return;
	}
	registeredReminderUi.add(plugin);

	const queryProcessor = new ReminderQueryInjector(plugin);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onNewBlock(source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-tasks',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onNewBlock(source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-today',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onTodayBlock(source, el, ctx),
	);
	plugin.registerMarkdownCodeBlockProcessor(
		'reminders-upcoming',
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onUpcomingBlock(source, el, ctx),
	);

	try {
		plugin.registerEditorExtension(createRemindersBlockExtension(plugin));
	} catch (error) {
		remindersLogger.error('Failed to register reminder block extension:', error);
	}
	plugin.registerView(
		VIEW_TYPE_REMINDERS,
		(leaf) => new RemindersView(leaf, plugin),
	);
	plugin.addRibbonIcon('check-circle', 'Open reminders', () => {
		void plugin.activateRemindersView();
	});

	registerReminderCommands(plugin);

	plugin.addCommand({
		id: 'open-reminders-view',
		name: 'Open reminders sidebar',
		callback: () => plugin.activateRemindersView(),
	});
	plugin.addCommand({
		id: 'open-reminders-fullscreen',
		name: 'Open reminders full screen',
		callback: () => openFullScreenReminderModal(plugin),
	});

	if (plugin.remindersSettings.autoOpenView !== 'none') {
		plugin.app.workspace.onLayoutReady(() => {
			if (plugin.remindersSettings.autoOpenView === 'sidebar') {
				void plugin.activateRemindersView();
			} else if (plugin.remindersSettings.autoOpenView === 'fullscreen') {
				openFullScreenReminderModal(plugin);
			}
		});
	}
}
