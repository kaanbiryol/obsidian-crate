/** Snapshot the visible surface, not its full-height positioning frame. */
export function measureSheetTravel(popup: HTMLElement | null): void {
	const surface = popup?.querySelector<HTMLElement>('.pwa-reminder-sheet-stage');
	if (!popup || !surface) return;
	popup.style.setProperty('--pwa-sheet-travel', `${surface.offsetHeight + 32}px`);
}
