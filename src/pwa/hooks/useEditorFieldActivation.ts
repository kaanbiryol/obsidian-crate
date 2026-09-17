import { useRef, type FocusEvent, type MouseEvent, type PointerEvent } from 'react';
import { moveCursorToEnd } from '@/reminders/utils/cursorPosition';

function editorField(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>('textarea, [contenteditable="true"]') : null;
}

function placeCaretAtEnd(field: HTMLElement): void {
	if (field instanceof HTMLTextAreaElement) {
		field.setSelectionRange(field.value.length, field.value.length);
		field.scrollTop = field.scrollHeight;
	} else moveCursorToEnd(field);
}

/** Enter a field at the end; subsequent taps, drags and selections remain native. */
export function useEditorFieldActivation() {
	const activation = useRef<{ field: HTMLElement; x: number; y: number; time: number } | null>(null);
	return {
		onFocusCapture(event: FocusEvent<HTMLDivElement>) {
			const field = editorField(event.target);
			if (field) placeCaretAtEnd(field);
		},
		onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
			const field = editorField(event.target);
			activation.current = field && field !== field.ownerDocument.activeElement && event.button === 0
				? { field, x: event.clientX, y: event.clientY, time: event.timeStamp } : null;
			if (activation.current && event.pointerType === 'touch') {
				// Keep the existing synchronous focus that prevents iOS document panning.
				field?.focus({ preventScroll: true });
			}
		},
		onPointerMoveCapture(event: PointerEvent<HTMLDivElement>) {
			const tap = activation.current;
			if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) activation.current = null;
		},
		onPointerCancelCapture() { activation.current = null; },
		onContextMenuCapture() { activation.current = null; },
		onClickCapture(event: MouseEvent<HTMLDivElement>) {
			const tap = activation.current;
			activation.current = null;
			// Native pointer handling can replace the focus selection before click.
			// Correct only a short activation tap, never an existing-field selection.
			if (tap && event.timeStamp - tap.time < 500 && editorField(event.target) === tap.field
				&& tap.field.ownerDocument.activeElement === tap.field) placeCaretAtEnd(tap.field);
		},
	};
}
