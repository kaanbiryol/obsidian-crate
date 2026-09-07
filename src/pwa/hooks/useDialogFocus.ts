import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE_SELECTOR = [
	'button:not([disabled])',
	'a[href]',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

function activeElementWithin(element: HTMLElement): Element | null {
	const root = element.getRootNode();
	return root instanceof ShadowRoot ? root.activeElement : element.ownerDocument.activeElement;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
	return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
		.filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
}

function focusDialog(dialog: HTMLElement): void {
	if (dialog.contains(activeElementWithin(dialog))) return;
	dialog.focus({ preventScroll: true });
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>, dialog: HTMLElement): void {
	if (event.key !== 'Tab') return;

	const controls = focusableElements(dialog);
	if (controls.length === 0) {
		event.preventDefault();
		dialog.focus({ preventScroll: true });
		return;
	}

	const firstControl = controls.at(0);
	const lastControl = controls.at(-1);
	if (!firstControl || !lastControl) return;
	const activeElement = activeElementWithin(dialog);
	if (event.shiftKey && (activeElement === dialog || activeElement === firstControl || !dialog.contains(activeElement))) {
		event.preventDefault();
		lastControl.focus();
	} else if (!event.shiftKey && (activeElement === dialog || activeElement === lastControl || !dialog.contains(activeElement))) {
		event.preventDefault();
		firstControl.focus();
	}
}

export function useDialogFocus({
	activeKey,
	autoFocus = true,
	escapeDisabled = false,
	onEscape,
}: {
	activeKey: string;
	autoFocus?: boolean;
	escapeDisabled?: boolean;
	onEscape: () => void;
}) {
	const dialogRef = useRef<HTMLElement | null>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);
	const escapeDisabledRef = useRef(escapeDisabled);
	const onEscapeRef = useRef(onEscape);

	useLayoutEffect(() => {
		escapeDisabledRef.current = escapeDisabled;
		onEscapeRef.current = onEscape;
	});

	useEffect(() => {
		const activeElement = document.activeElement;
		previousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
		return () => {
			const previousFocus = previousFocusRef.current;
			if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, []);

	useLayoutEffect(() => {
		if (!autoFocus) return;
		const frame = window.requestAnimationFrame(() => {
			if (dialogRef.current) focusDialog(dialogRef.current);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [activeKey, autoFocus]);

	const setDialogRef = useCallback((element: HTMLElement | null) => {
		dialogRef.current = element;
	}, []);

	const handleDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		if (event.key === 'Escape') {
			if (escapeDisabledRef.current) return;
			event.preventDefault();
			event.stopPropagation();
			onEscapeRef.current();
			return;
		}

		trapDialogFocus(event, dialog);
	}, []);

	return { handleDialogKeyDown, setDialogRef };
}
