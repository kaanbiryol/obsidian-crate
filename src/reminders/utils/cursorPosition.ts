/**
 * Utilities for saving and restoring cursor position in contenteditable elements
 */

/**
 * Save the current cursor position as a character offset
 * @param element - The contenteditable element
 * @returns Character offset from start, or null if no selection
 */
export const saveCursorPosition = (element: HTMLElement | null): number | null => {
    if (!element) return null;

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;

    const range = sel.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    return preCaretRange.toString().length;
};

/**
 * Restore cursor position from a character offset
 * @param element - The contenteditable element
 * @param position - Character offset to restore
 */
export const restoreCursorPosition = (element: HTMLElement | null, position: number | null): void => {
    if (position === null || !element) return;

    const sel = window.getSelection();
    if (!sel) return;

    let charCount = 0;
    let foundPosition = false;

    const walk = (node: Node) => {
        if (foundPosition) return;

        if (node.nodeType === Node.TEXT_NODE) {
            const textContent = node.textContent || '';
            const nextCharCount = charCount + textContent.length;
            if (position <= nextCharCount) {
                const range = document.createRange();
                range.setStart(node, Math.min(position - charCount, textContent.length));
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                foundPosition = true;
                return;
            }
            charCount = nextCharCount;
        } else if (node.childNodes) {
            for (const child of Array.from(node.childNodes)) {
                walk(child);
                if (foundPosition) return;
            }
        }
    };

    walk(element);
};

/**
 * Move cursor to end of contenteditable element
 */
export const moveCursorToEnd = (element: HTMLElement | null): void => {
    if (!element) return;

    const range = document.createRange();
    const sel = window.getSelection();
    if (!sel) return;

    range.selectNodeContents(element);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
};
