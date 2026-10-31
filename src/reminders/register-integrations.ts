import { setReminderRibbon } from './visibility';
import { addIcon, editorInfoField } from 'obsidian';
import type { EditorState } from '@codemirror/state';
import type CratePlugin from '../plugin/CratePlugin';
import { registerReminderCommands } from './commands';
import { renderRemindersBlock } from './query/injector';
import { RemindersView, VIEW_TYPE_REMINDERS } from './ui/plugin/reminders-view';
import { createLogger } from './logger';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { CRATE_ICON_ID, CRATE_ICON_SVG } from '../ui/crate-icon';
import { createReminderIdMarkerHiding, createReminderLineLeaveExtension } from './data/editor-line-leave';

const remindersLogger = createLogger('Reminders');
const registeredReminderUi = new WeakSet<CratePlugin>();

export async function registerReminderIntegrations(plugin: CratePlugin, openView: () => Promise<void>): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (registeredReminderUi.has(plugin)) {
		return;
	}
	registeredReminderUi.add(plugin);

	for (const type of ['reminders', 'reminders-today', 'reminders-upcoming'] as const) {
		plugin.registerMarkdownCodeBlockProcessor(type, (source, el, ctx) => renderRemindersBlock(plugin, type, source, el, ctx));
	}

	addIcon(CRATE_ICON_ID, CRATE_ICON_SVG);
	plugin.registerView(
		VIEW_TYPE_REMINDERS,
		(leaf) => new RemindersView(leaf, plugin),
	);
	const ribbon = plugin.addRibbonIcon(CRATE_ICON_ID, 'Open Crate', () => {
		void openView();
	});

	setReminderRibbon(plugin, ribbon);
	const editorPath = (state: EditorState) => state.field(editorInfoField, false)?.file?.path;
	plugin.registerEditorExtension([
		createReminderLineLeaveExtension(state => {
			const path = editorPath(state);
			return Boolean(path && plugin.reminders?.canAssignEditorIds(path));
		}),
		createReminderIdMarkerHiding(state => {
			const path = editorPath(state);
			return Boolean(path && plugin.reminders?.index.isReminderFile(path));
		}),
	]);
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
