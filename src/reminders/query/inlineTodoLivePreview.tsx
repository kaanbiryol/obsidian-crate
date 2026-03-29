import { editorViewField } from 'obsidian';
import {
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from '@codemirror/view';
import type CratePlugin from '@/main';
import { getLineReminderMappingService } from '@/reminders/services/lineReminderMapping';
import { buildInlineTodoDecorations } from './inlineTodoLivePreviewDecorations';
import { createInlineTodoController } from './inlineTodoLivePreviewController';

export function createInlineTodoExtension(plugin: CratePlugin) {
	const mappingService = getLineReminderMappingService();
	const controller = createInlineTodoController(plugin, mappingService);

	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private filePath: string | undefined;
			private previousLineNum: number | null = null;

			constructor(view: EditorView) {
				const file = view.state.field(editorViewField)?.file;
				this.filePath = file?.path;
				this.decorations = buildInlineTodoDecorations(view, plugin, mappingService);
				this.previousLineNum = view.state.doc.lineAt(view.state.selection.main.head).number;

				if (this.filePath) {
					void controller.reconcileFile(view, this.filePath);
				}
			}

			update(update: ViewUpdate) {
				const file = update.view.state.field(editorViewField)?.file;
				const newFilePath = file?.path;

				if (newFilePath !== this.filePath) {
					this.filePath = newFilePath;
					if (newFilePath) {
						void controller.reconcileFile(update.view, newFilePath);
					}
				}

				if (update.docChanged && this.filePath) {
					const currentLineNum = update.state.doc.lineAt(update.state.selection.main.head).number;
					if (this.previousLineNum !== null && this.previousLineNum !== currentLineNum) {
						const previousLineNum = this.previousLineNum;
						const filePath = this.filePath;
						setTimeout(() => {
							void controller.processLineOnLeave(update.view, filePath, previousLineNum);
						}, 0);
					}
					this.previousLineNum = currentLineNum;
				}

				if (update.docChanged || update.viewportChanged || update.selectionSet) {
					this.decorations = buildInlineTodoDecorations(update.view, plugin, mappingService);
				}
			}
		},
		{
			decorations: (value) => value.decorations,
		},
	);
}
