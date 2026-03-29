import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { format, isToday, isTomorrow } from 'date-fns';
import * as chrono from 'chrono-node';
import { findAllMatches } from '@/reminders';
import type CratePlugin from '@/main';
import { isInRemindersFolder } from '@/reminders/data/vaultScanner';
import type { LineReminderMappingService } from '@/reminders/services/lineReminderMapping';
import { isCheckboxLine } from '@/reminders/utils/checkboxParser';
import { getEditorFile } from './editorFile';
import { InlineChipWidget, isRecurrenceText } from './inlineTodoLivePreviewWidget';

function isInsideCodeBlock(view: EditorView, pos: number): boolean {
	let insideCodeBlock = false;

	syntaxTree(view.state).iterate({
		from: 0,
		to: pos + 1,
		enter: (node) => {
			if (
				node.name === 'FencedCode' ||
				node.name === 'CodeBlock' ||
				node.name.includes('codeblock')
			) {
				if (pos >= node.from && pos <= node.to) {
					insideCodeBlock = true;
				}
			}
		},
	});

	return insideCodeBlock;
}

function formatDateChipText(dateText: string): string {
	const parsed = chrono.parseDate(dateText);
	if (!parsed) {
		return dateText;
	}

	if (isToday(parsed)) {
		const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
		return hasTime ? format(parsed, "'Today' HH:mm") : 'Today';
	}
	if (isTomorrow(parsed)) {
		const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
		return hasTime ? format(parsed, "'Tomorrow' HH:mm") : 'Tomorrow';
	}

	const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
	return hasTime ? format(parsed, 'MMM d HH:mm') : format(parsed, 'MMM d');
}

export function buildInlineTodoDecorations(
	view: EditorView,
	plugin: CratePlugin,
	mappingService: LineReminderMappingService,
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const cursorPos = view.state.selection.main.head;
	const file = getEditorFile(view.state);
	const filePath = file?.path;

	if (!filePath) {
		return builder.finish();
	}

	const remindersFolderPath = plugin.remindersSettings.remindersFolderPath;
	if (!isInRemindersFolder(filePath, remindersFolderPath)) {
		return builder.finish();
	}

	const doc = view.state.doc;
	const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];

	for (const { from, to } of view.visibleRanges) {
		const startLine = doc.lineAt(from).number;
		const endLine = doc.lineAt(to).number;

		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			const line = doc.line(lineNum);
			if (!isCheckboxLine(line.text) || isInsideCodeBlock(view, line.from)) {
				continue;
			}

			const cursorOnLine = cursorPos >= line.from && cursorPos <= line.to;
			if (cursorOnLine) {
				continue;
			}

			const checkboxMatch = line.text.match(/^(\s*-\s*\[[ xX]\]\s*)/);
			if (!checkboxMatch) {
				continue;
			}

			const isCompleted = /\[[xX]\]/.test(checkboxMatch[0]);
			const contentStart = checkboxMatch[0].length;
			const content = line.text.slice(contentStart);
			const matches = findAllMatches(content);

			for (const match of matches) {
				if (match.type === 'project') {
					continue;
				}

				let leadingSpaces = 0;
				const matchStart = match.index;
				if (matchStart > 0 && content[matchStart - 1] === ' ') {
					leadingSpaces = 1;
					let index = matchStart - 2;
					while (index >= 0 && content[index] === ' ') {
						leadingSpaces++;
						index--;
					}
				}

				const replaceFrom = line.from + contentStart + match.index - leadingSpaces;
				const replaceTo = line.from + contentStart + match.index + match.length;

				let displayText = match.text;
				if (match.type === 'date' && !isRecurrenceText(match.text)) {
					displayText = formatDateChipText(match.text);
				}

				const widget = new InlineChipWidget(
					match.type,
					match.text,
					displayText,
					plugin,
					filePath,
					lineNum,
					mappingService,
					isCompleted,
					view,
					line.from,
					line.to,
				);

				decorations.push({
					from: replaceFrom,
					to: replaceTo,
					deco: Decoration.replace({ widget }),
				});
			}
		}
	}

	decorations.sort((left, right) => left.from - right.from || left.to - right.to);
	for (const { from, to, deco } of decorations) {
		builder.add(from, to, deco);
	}

	return builder.finish();
}
