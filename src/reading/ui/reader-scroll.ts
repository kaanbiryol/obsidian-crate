/** The PWA phone reader uses the document; embedded readers own their scroll. */
export function readerScrollElement(reader: HTMLElement): HTMLElement {
	return reader.dataset.documentScroll === 'true'
		? reader.ownerDocument.scrollingElement as HTMLElement ?? reader
		: reader;
}
