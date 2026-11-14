import type { MarkdownPostProcessorContext } from 'obsidian';
import { extractReminderId } from '../core/reminderIdentity';
import { createReminderDateChip, reminderDateDisplay } from './reminder-date-display';

/** Replaces the last occurrence of `text` in an item's own text, outside nested lists, with `replacement`. */
function replaceItemText(item: HTMLElement, text: string, replacement: HTMLElement): void {
	const walker = item.ownerDocument.createTreeWalker(item, NodeFilter.SHOW_TEXT);
	let found: { node: Text; index: number } | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const index = node.data.lastIndexOf(text);
		if (index !== -1 && node.parentElement?.closest('li') === item) found = { node, index };
	}
	if (!found) return;
	const { node, index } = found;
	const after = node.data.slice(index + text.length);
	node.data = node.data.slice(0, index);
	node.after(replacement, node.ownerDocument.createTextNode(after));
}

/**
 * Shows saved reminder dates in reading view as the same chips the editor shows,
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
			const display = text ? reminderDateDisplay(text, now) : null;
			if (!text || display?.kind !== 'chip') continue;
			const id = extractReminderId(text);
			replaceItemText(item, text.slice(display.from, display.to), createReminderDateChip(display.label, display.overdue, () => {
				if (id) openReminder(id);
			}));
		}
	};
}
