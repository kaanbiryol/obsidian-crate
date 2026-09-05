import { useLayoutEffect, type RefObject } from 'react';

/** Fit the editor to its natural rows, including wrapped chips and resized text. */
export function useEditorSheetHeight(ref: RefObject<HTMLDivElement | null>, active: boolean): void {
	useLayoutEffect(() => {
		const editor = ref.current;
		const container = editor?.closest<HTMLElement>('.pwa-modal-sheet__container');
		if (!active || !editor || !container) return;
		const rows = [
			editor.querySelector<HTMLElement>('.reminder-modal-header'),
			editor.querySelector<HTMLElement>('.reminder-editor-fields'),
			editor.querySelector<HTMLElement>('.reminder-action-chips'),
		].filter((row): row is HTMLElement => row !== null);
		const measure = () => {
			// Offset sizes exclude the sheet's animated transform. Include its borders.
			const height = rows.reduce((total, row) => total + row.offsetHeight, 2);
			container.style.setProperty('--pwa-editor-content-height', `${height}px`);
		};
		measure();
		const observer = new ResizeObserver(measure);
		rows.forEach(row => observer.observe(row));
		return () => observer.disconnect();
	}, [active, ref]);
}
