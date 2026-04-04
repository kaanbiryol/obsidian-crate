/**
 * Utilities for saving and restoring cursor position in contenteditable elements
 */

const TEXT_NODE_TYPE = typeof Node !== 'undefined' ? Node.TEXT_NODE : 3;

export type ResolvedCursorPosition =
	| { type: 'node'; container: Node; offset: number }
	| { type: 'after-node'; node: Node };

function getChildNodes(node: Node | null): Node[] {
	if (!node || !('childNodes' in node) || !node.childNodes) {
		return [];
	}

	return Array.from(node.childNodes);
}

function isTextNode(node: Node | null): node is Node {
	return !!node && node.nodeType === TEXT_NODE_TYPE;
}

function isLineBreakNode(node: Node | null): node is Node {
	return !!node && node.nodeName === 'BR';
}

function containsNode(root: Node | null, target: Node | null): boolean {
	if (!root || !target) {
		return false;
	}

	if (root === target) {
		return true;
	}

	return getChildNodes(root).some((child) => containsNode(child, target));
}

export function getLogicalTextLength(node: Node | null): number {
	if (!node) {
		return 0;
	}

	if (isTextNode(node)) {
		return node.textContent?.length ?? 0;
	}

	if (isLineBreakNode(node)) {
		return 1;
	}

	return getChildNodes(node).reduce((total, child) => total + getLogicalTextLength(child), 0);
}

export function getLogicalCursorOffset(
	root: Node | null,
	container: Node | null,
	offset: number,
): number | null {
	if (!root || !container || !containsNode(root, container)) {
		return null;
	}

	const clampedOffset = Math.max(0, offset);
	let logicalOffset = 0;
	let found = false;

	const walk = (node: Node): boolean => {
		if (node === container) {
			if (isTextNode(node)) {
				const textLength = node.textContent?.length ?? 0;
				logicalOffset += Math.min(clampedOffset, textLength);
				found = true;
				return true;
			}

			if (isLineBreakNode(node)) {
				logicalOffset += clampedOffset > 0 ? 1 : 0;
				found = true;
				return true;
			}

			const children = getChildNodes(node);
			const childLimit = Math.min(clampedOffset, children.length);
			for (let index = 0; index < childLimit; index++) {
				logicalOffset += getLogicalTextLength(children[index] ?? null);
			}
			found = true;
			return true;
		}

		if (isTextNode(node)) {
			logicalOffset += node.textContent?.length ?? 0;
			return false;
		}

		if (isLineBreakNode(node)) {
			logicalOffset += 1;
			return false;
		}

		for (const child of getChildNodes(node)) {
			if (walk(child)) {
				return true;
			}
		}

		return false;
	};

	walk(root);
	return found ? logicalOffset : null;
}

export function resolveLogicalCursorPosition(
	root: Node | null,
	position: number | null,
): ResolvedCursorPosition | null {
	if (!root || position === null) {
		return null;
	}

	const target = Math.max(0, Math.min(position, getLogicalTextLength(root)));
	let logicalOffset = 0;

	const walk = (node: Node): ResolvedCursorPosition | null => {
		if (isTextNode(node)) {
			const textLength = node.textContent?.length ?? 0;
			if (target <= logicalOffset + textLength) {
				return {
					type: 'node',
					container: node,
					offset: Math.max(0, target - logicalOffset),
				};
			}

			logicalOffset += textLength;
			return null;
		}

		if (isLineBreakNode(node)) {
			if (target === logicalOffset) {
				return null;
			}

			logicalOffset += 1;
			if (target <= logicalOffset) {
				return {
					type: 'after-node',
					node,
				};
			}

			return null;
		}

		const children = getChildNodes(node);
		if (!children.length) {
			return target === logicalOffset
				? {
					type: 'node',
					container: node,
					offset: 0,
				}
				: null;
		}

		for (let index = 0; index < children.length; index++) {
			const child = children[index] ?? null;
			if (isLineBreakNode(child) && target === logicalOffset) {
				return {
					type: 'node',
					container: node,
					offset: index,
				};
			}

			if (!child) {
				continue;
			}

			const resolved = walk(child);
			if (resolved) {
				return resolved;
			}
		}

		return target === logicalOffset
			? {
				type: 'node',
				container: node,
				offset: children.length,
			}
			: null;
	};

	const resolved = walk(root);
	if (resolved) {
		return resolved;
	}

	return {
		type: 'node',
		container: root,
		offset: getChildNodes(root).length,
	};
}

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
    return getLogicalCursorOffset(element, range.endContainer, range.endOffset);
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

    const resolved = resolveLogicalCursorPosition(element, position);
    const range = document.createRange();

    if (!resolved) {
        range.selectNodeContents(element);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
    }

    if (resolved.type === 'after-node') {
        range.setStartAfter(resolved.node);
    } else {
        range.setStart(resolved.container, resolved.offset);
    }

    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
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
