import type { MarkdownPostProcessorContext } from 'obsidian';
import { extractReminderId } from '../core/reminderIdentity';
import { findStandalonePriorityMarkerIndexes } from '../core/grammar/priorityMarker';
import { createImportantChip, createReminderDateChip, importantMarker, reminderDateDisplay } from './reminder-date-display';

/**
 * Replaces the last place `find` reports in an item's own text, outside nested
 * lists, with `replacement`. `find` returns an index in a text node's data, or -1.
 */
function replaceItemText(item: HTMLElement, length: number, find: (data: string) => number, replacement: HTMLElement): void {
	const walker = item.ownerDocument.createTreeWalker(item, NodeFilter.SHOW_TEXT);
	let found: { node: Text; index: number } | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const index = find(node.data);
		if (index !== -1 && node.parentElement?.closest('li') === item) found = { node, index };
	}
	if (!found) return;
	const { node, index } = found;
	const after = node.data.slice(index + length);
	node.data = node.data.slice(0, index);
	node.after(replacement, node.ownerDocument.createTextNode(after));
}

/**
 * Shows saved reminder dates and important markers in reading view as the same chips the editor shows,
 * reading each task's schedule from its source line rather than the rendered text.
 */
export function createReadingDateChips(isReminderFile: (path: string) => boolean, openReminder: (reminderId: string) => void) {
	return (element: HTMLElement, context: MarkdownPostProcessorContext) => {
		if (!isReminderFile(context.sourcePath)) return;
		const items = element.querySelectorAll<HTMLElement>('li.task-list-item[data-line]');
		const section = items.length ? context.getSectionInfo(element) : null;
		if (!section) return;
		const lines = section.text.split('\n'), now = new Date();
		for (const item of items) {
			const text = lines[section.lineStart + Number(item.dataset.line)];
			if (!text) continue;
			if (importantMarker(text)) {
				replaceItemText(item, 1, data => findStandalonePriorityMarkerIndexes(data).at(-1) ?? -1, createImportantChip());
			}
			const display = reminderDateDisplay(text, now);
			if (display?.kind !== 'chip') continue;
			const id = extractReminderId(text), stored = text.slice(display.from, display.to);
			replaceItemText(item, stored.length, data => data.lastIndexOf(stored), createReminderDateChip(display.label, display.overdue, () => {
				if (id) openReminder(id);
			}));
		}
	};
}
