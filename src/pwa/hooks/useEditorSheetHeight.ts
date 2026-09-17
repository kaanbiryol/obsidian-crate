import { useLayoutEffect, type RefObject } from 'react';
import { measureSheetTravel } from '../sheet-geometry';

/** Fit the editor to its natural rows, including wrapped chips and resized text. */
export function useEditorSheetHeight(ref: RefObject<HTMLDivElement | null>, active: boolean, confirmingDelete = false): void {
	useLayoutEffect(() => {
		const editor = ref.current;
		const container = editor?.closest<HTMLElement>('.pwa-modal-sheet__container');
		if (!active || !editor || !container) return;
		const rows = confirmingDelete ? [editor.querySelector<HTMLElement>('.pwa-delete-confirmation')].filter((row): row is HTMLElement => row !== null) : [
			editor.querySelector<HTMLElement>('.reminder-modal-header'),
			editor.querySelector<HTMLElement>('.reminder-editor-fields'),
			editor.querySelector<HTMLElement>('.reminder-action-chips'),
		].filter((row): row is HTMLElement => row !== null);
		let lastHeight = -1;
		const measure = () => {
			// Offset sizes exclude the sheet's animated transform. Include its borders.
			const height = rows.reduce((total, row) => total + row.offsetHeight, 2);
			if (height === lastHeight) return;
			lastHeight = height;
			container.style.setProperty('--pwa-editor-content-height', `${height}px`);
			// Initial row sizing must also set the entrance distance before paint.
			measureSheetTravel(container);
		};
		measure();
		let frame = 0;
		const observer = new ResizeObserver(() => {
			// Changing an ancestor's height during resize delivery can resize the
			// observed rows again, producing a WebKit ResizeObserver loop error.
			// Initial sizing above stays synchronous; later changes share one frame.
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				measure();
			});
		});
		rows.forEach(row => observer.observe(row));
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [active, ref, confirmingDelete]);
}
