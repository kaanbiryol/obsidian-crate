/** Snapshot the visible surface, not its full-height positioning frame. */
export function measureSheetTravel(popup: HTMLElement | null): void {
	// A percentage travel would rescale mid-entrance when the keyboard inset grows the surface.
	const surface = popup?.querySelector<HTMLElement>('.pwa-sheet-surface');
	if (!popup || !surface) return;
	popup.style.setProperty('--pwa-sheet-travel', `${surface.offsetHeight + 32}px`);
}
