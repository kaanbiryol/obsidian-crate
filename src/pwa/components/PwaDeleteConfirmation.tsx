import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DeleteConfirmationModal } from '@/reminders/components/DeleteConfirmationModal';

/** Keep the editor's keyboard and selection in place until deletion is confirmed. */
export function PwaDeleteConfirmation({
	id,
	keyboardInset,
	message,
	isLoading,
	onClose,
	onConfirm,
}: {
	id: string;
	keyboardInset: number;
	message: string;
	isLoading: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);
	const preserveEditorFocusRef = useRef(keyboardInset > 0);
	const callbacksRef = useRef({ isLoading, onClose });
	callbacksRef.current = { isLoading, onClose };
	const closeConfirmation = () => {
		if (callbacksRef.current.isLoading) return;
		if (overlayRef.current?.contains(document.activeElement)) {
			previousFocusRef.current?.focus({ preventScroll: true });
		}
		callbacksRef.current.onClose();
	};
	const closeRef = useRef(closeConfirmation);
	closeRef.current = closeConfirmation;

	useLayoutEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		const previousFocus = document.activeElement;
		previousFocusRef.current = previousFocus instanceof HTMLElement ? previousFocus : null;
		// Touch keeps editable focus, which keeps the software keyboard visible.
		// With a hardware keyboard, focus the message rather than either action.
		if (!preserveEditorFocusRef.current || !(previousFocus instanceof HTMLElement)
			|| !previousFocus.matches('input, textarea, [contenteditable="true"]')) {
			overlay.querySelector<HTMLElement>('[role="alertdialog"]')?.focus({ preventScroll: true });
		}
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				closeRef.current();
			} else if (event.key === 'Tab') {
				event.preventDefault();
				event.stopPropagation();
				const controls = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
				const activeIndex = controls.findIndex(control => control === document.activeElement);
				const nextIndex = event.shiftKey
					? (activeIndex <= 0 ? controls.length - 1 : activeIndex - 1)
					: (activeIndex + 1) % controls.length;
				controls[nextIndex]?.focus({ preventScroll: true });
			} else if (!overlay.contains(event.target as Node)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const blockEditorInput = (event: Event) => {
			if (overlay.contains(event.target as Node)) return;
			event.preventDefault();
			event.stopPropagation();
		};
		document.addEventListener('keydown', handleKeyDown, true);
		document.addEventListener('beforeinput', blockEditorInput, true);
		document.addEventListener('click', blockEditorInput, true);
		document.addEventListener('paste', blockEditorInput, true);
		document.addEventListener('cut', blockEditorInput, true);
		document.addEventListener('drop', blockEditorInput, true);
		return () => {
			document.removeEventListener('keydown', handleKeyDown, true);
			document.removeEventListener('beforeinput', blockEditorInput, true);
			document.removeEventListener('click', blockEditorInput, true);
			document.removeEventListener('paste', blockEditorInput, true);
			document.removeEventListener('cut', blockEditorInput, true);
			document.removeEventListener('drop', blockEditorInput, true);
		};
	}, []);

	const content = (
		<div
			id={id}
			ref={overlayRef}
			className="pwa-delete-confirmation"
			style={{ '--pwa-confirmation-keyboard-inset': `${keyboardInset}px` } as React.CSSProperties}
			onPointerDownCapture={event => event.preventDefault()}
			onMouseDownCapture={event => event.preventDefault()}
			// Wait for the backdrop click so its matching touchend cannot hit the sheet underneath.
			onTouchStartCapture={event => event.stopPropagation()}
		>
			<DeleteConfirmationModal
				isOpen
				showCloseButton={false}
				autoFocusCancel={false}
				message={message}
				isLoading={isLoading}
				onClose={closeConfirmation}
				onConfirm={onConfirm}
			/>
		</div>
	);
	const mountPoint = typeof document === 'undefined' ? null : document.querySelector('.pwa-shadow-root');
	return mountPoint ? createPortal(content, mountPoint) : content;
}
