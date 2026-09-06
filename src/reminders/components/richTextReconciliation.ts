const ACTIVE_CHIP_CLASS = 'is-cursor-active';

function matches(current: Node, expected: Node): boolean {
	if (current.isEqualNode(expected)) return true;
	if (current.nodeType !== Node.ELEMENT_NODE) return false;
	const element = current as Element;
	if (!element.classList.contains(ACTIVE_CHIP_CLASS)) return false;
	// Compare without changing live presentation or disturbing the selection.
	const normalized = element.cloneNode(true) as Element;
	normalized.classList.remove(ACTIVE_CHIP_CLASS);
	return normalized.isEqualNode(expected);
}

/** Keep unchanged prefixes/suffixes and update only the edited nodes in between. */
export function reconcileRichTextChildren(element: HTMLElement, fragment: DocumentFragment): void {
	const current = Array.from(element.childNodes);
	const expected = Array.from(fragment.childNodes);
	let start = 0;
	while (start < current.length && start < expected.length && matches(current[start]!, expected[start]!)) start++;
	let oldEnd = current.length;
	let newEnd = expected.length;
	while (oldEnd > start && newEnd > start && matches(current[oldEnd - 1]!, expected[newEnd - 1]!)) {
		oldEnd--;
		newEnd--;
	}
	const anchor = current[oldEnd] ?? null;
	for (let index = start; index < Math.max(oldEnd, newEnd); index++) {
		const previous = index < oldEnd ? current[index]! : null;
		const next = index < newEnd ? expected[index]! : null;
		if (!next) {
			if (previous) element.removeChild(previous);
		} else if (!previous) {
			element.insertBefore(next, anchor);
		} else if (!matches(previous, next)) {
			if (previous.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) {
				previous.nodeValue = next.nodeValue;
			} else {
				element.replaceChild(next, previous);
			}
		}
	}
}
