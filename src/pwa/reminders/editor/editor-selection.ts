import { getEditorSelectionRange } from '@/reminders/utils/editorSelection';
import { getLogicalCursorOffset, resolveLogicalCursorPosition } from '@/reminders/utils/cursorPosition';

export function captureTitleSelection(element: HTMLElement) {
	const range = getEditorSelectionRange(element);
	if (!range) return null;
	const selection = element.ownerDocument.getSelection();
	return {
		start: getLogicalCursorOffset(element, range.startContainer, range.startOffset),
		end: getLogicalCursorOffset(element, range.endContainer, range.endOffset),
		backward: selection?.focusNode === range.startContainer && selection.focusOffset === range.startOffset,
	};
}

export function restoreTitleSelection(element: HTMLElement, saved: ReturnType<typeof captureTitleSelection>): void {
	if (!saved) return;
	const range = element.ownerDocument.createRange();
	const start = resolveLogicalCursorPosition(element, saved.start);
	const end = resolveLogicalCursorPosition(element, saved.end);
	if (!start || !end) return;
	if (start.type === 'after-node') range.setStartAfter(start.node);
	else range.setStart(start.container, start.offset);
	if (end.type === 'after-node') range.setEndAfter(end.node);
	else range.setEnd(end.container, end.offset);
	const selection = element.ownerDocument.getSelection();
	if (saved.backward) selection?.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
	else selection?.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset);
}

/** Reveal only within the field/body; never scroll the document or sheet wrappers. */
export function revealTitleCaret(element: HTMLElement, body: HTMLElement | null): void {
	const range = getEditorSelectionRange(element);
	if (!range?.collapsed) return;
	const rect = range.getBoundingClientRect();
	if (!rect.height) return;
	const bounds = element.getBoundingClientRect();
	const padding = 4;
	const delta = rect.bottom > bounds.bottom - padding
		? rect.bottom - bounds.bottom + padding
		: rect.top < bounds.top + padding ? rect.top - bounds.top - padding : 0;
	element.scrollTop += delta;
	if (!body) return;
	const caret = range.getBoundingClientRect();
	const viewport = body.getBoundingClientRect();
	if (caret.bottom > viewport.bottom - padding) body.scrollTop += caret.bottom - viewport.bottom + padding;
	else if (caret.top < viewport.top + padding) body.scrollTop += caret.top - viewport.top - padding;
}
