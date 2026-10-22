/** A PWA phone screen can hand its scrolling to the document; others scroll themselves. */
export function scrollPort(element: HTMLElement): HTMLElement {
	return element.dataset.documentScroll === 'true'
		? element.ownerDocument.scrollingElement as HTMLElement ?? element
		: element;
}
