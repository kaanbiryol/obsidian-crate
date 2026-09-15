type ComposedSelection = Selection & {
	getComposedRanges?(options: { shadowRoots: ShadowRoot[] } | ShadowRoot): StaticRange[];
};

/** Resolve an editor selection without WebKit retargeting it to the shadow host. */
export function getEditorSelectionRange(element: HTMLElement): Range | null {
	const selection = element.ownerDocument.getSelection() as ComposedSelection | null;
	if (!selection?.rangeCount) return null;
	let range = selection.getRangeAt(0);
	const containsRange = () => element.contains(range.startContainer) && element.contains(range.endContainer);
	if (containsRange()) return range;

	const root = element.getRootNode();
	if ('host' in root && selection.getComposedRanges) {
		// Older Safari versions accepted shadow roots directly, before the options
		// form was standardized. Never let an unsupported form interrupt typing.
		for (const options of [{ shadowRoots: [root as ShadowRoot] }, root as ShadowRoot]) {
			try {
				const composed = selection.getComposedRanges(options)[0];
				if (!composed || !element.contains(composed.startContainer) || !element.contains(composed.endContainer)) continue;
				range = element.ownerDocument.createRange();
				range.setStart(composed.startContainer, composed.startOffset);
				range.setEnd(composed.endContainer, composed.endOffset);
				return range;
			} catch {
				// Fall through to the legacy form, then leave an unresolved selection alone.
			}
		}
	}
	return null;
}
