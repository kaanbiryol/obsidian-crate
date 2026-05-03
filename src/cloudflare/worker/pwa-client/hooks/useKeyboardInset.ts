import { useEffect } from 'react';

const KEYBOARD_OVERLAY_THRESHOLD = 24;
const KEYBOARD_RESIZE_THRESHOLD = 80;
const KEYBOARD_WIDTH_RESET_THRESHOLD = 40;
const KEYBOARD_INPUT_SELECTOR = 'input, textarea, [contenteditable="true"]';

let keyboardClosedViewportHeight = 0;
let keyboardClosedViewportWidth = 0;

function isKeyboardInput(element: Element | null): element is HTMLElement {
	return element instanceof HTMLElement && element.matches(KEYBOARD_INPUT_SELECTOR);
}

function scrollFocusedEditorFieldIntoView(): void {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return;
	if (!active.matches(KEYBOARD_INPUT_SELECTOR)) return;
	const sheet = active.closest('.pwa-reminder-editor, .pwa-picker-sheet');
	if (!(sheet instanceof HTMLElement)) return;

	const viewport = window.visualViewport;
	const viewportTop = viewport?.offsetTop ?? 0;
	const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
	const sheetRect = sheet.getBoundingClientRect();
	const visibleTop = Math.max(viewportTop, sheetRect.top);
	const visibleBottom = Math.min(viewportBottom, sheetRect.bottom);
	const fieldRect = active.getBoundingClientRect();
	const margin = 18;

	if (fieldRect.top >= visibleTop + margin && fieldRect.bottom <= visibleBottom - margin) return;

	active.scrollIntoView({
		block: 'nearest',
		inline: 'nearest',
		behavior: 'smooth',
	});
}

function updateKeyboardInset(): number {
	const viewport = window.visualViewport;
	const viewportHeight = viewport?.height ?? window.innerHeight;
	const viewportWidth = viewport?.width ?? window.innerWidth;
	const viewportOffsetTop = viewport?.offsetTop ?? 0;
	const viewportBottom = viewportOffsetTop + viewportHeight;
	const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
	const focusedKeyboardInput = isKeyboardInput(document.activeElement);
	if (keyboardClosedViewportWidth && Math.abs(viewportWidth - keyboardClosedViewportWidth) > KEYBOARD_WIDTH_RESET_THRESHOLD) {
		keyboardClosedViewportHeight = 0;
		keyboardClosedViewportWidth = 0;
	}
	if (!focusedKeyboardInput) {
		// Keep the largest closed height so focus hops do not lower the baseline while the keyboard is still closing.
		keyboardClosedViewportHeight = Math.max(keyboardClosedViewportHeight, layoutHeight, viewportBottom);
		keyboardClosedViewportWidth = viewportWidth;
	} else if (keyboardClosedViewportHeight === 0) {
		keyboardClosedViewportHeight = Math.max(layoutHeight, viewportBottom);
		keyboardClosedViewportWidth = viewportWidth;
	}

	const keyboardOffset = Math.max(0, layoutHeight - viewportHeight - viewportOffsetTop);
	const resizedViewportKeyboardOffset = focusedKeyboardInput
		? Math.max(0, keyboardClosedViewportHeight - viewportBottom)
		: 0;
	const effectiveKeyboardOffset = Math.max(keyboardOffset, resizedViewportKeyboardOffset);
	const usableHeight = Math.max(0, viewportOffsetTop + viewportHeight);
	const roundedKeyboardOffset = Math.round(keyboardOffset);
	const keyboardIsOpen = roundedKeyboardOffset > KEYBOARD_OVERLAY_THRESHOLD
		|| resizedViewportKeyboardOffset > KEYBOARD_RESIZE_THRESHOLD;

	document.documentElement.style.setProperty('--keyboard-offset', `${roundedKeyboardOffset}px`);
	document.documentElement.style.setProperty('--keyboard-usable-height', `${Math.round(usableHeight)}px`);
	document.documentElement.classList.toggle('pwa-keyboard-open', keyboardIsOpen);
	return Math.round(effectiveKeyboardOffset);
}

export function useKeyboardInset(): void {
	useEffect(() => {
		const timers = new Set<number>();
		const updateAndScrollFocusedField = () => {
			const keyboardOffset = updateKeyboardInset();
			if (keyboardOffset > 24) scrollFocusedEditorFieldIntoView();
		};
		const scheduleUpdate = () => {
			updateKeyboardInset();
			window.requestAnimationFrame(updateAndScrollFocusedField);
			for (const delay of [80, 220, 420]) {
				const timer = window.setTimeout(() => {
					timers.delete(timer);
					updateAndScrollFocusedField();
				}, delay);
				timers.add(timer);
			}
		};

		scheduleUpdate();
		const viewport = window.visualViewport;
		if (!viewport) {
			window.addEventListener('orientationchange', scheduleUpdate);
			document.addEventListener('focusin', scheduleUpdate);
			document.addEventListener('focusout', scheduleUpdate);
			return () => {
				window.removeEventListener('orientationchange', scheduleUpdate);
				document.removeEventListener('focusin', scheduleUpdate);
				document.removeEventListener('focusout', scheduleUpdate);
				for (const timer of timers) window.clearTimeout(timer);
				timers.clear();
			};
		}

		viewport.addEventListener('resize', scheduleUpdate);
		viewport.addEventListener('scroll', scheduleUpdate);
		window.addEventListener('orientationchange', scheduleUpdate);
		document.addEventListener('focusin', scheduleUpdate);
		document.addEventListener('focusout', scheduleUpdate);
		return () => {
			viewport.removeEventListener('resize', scheduleUpdate);
			viewport.removeEventListener('scroll', scheduleUpdate);
			window.removeEventListener('orientationchange', scheduleUpdate);
			document.removeEventListener('focusin', scheduleUpdate);
			document.removeEventListener('focusout', scheduleUpdate);
			for (const timer of timers) window.clearTimeout(timer);
			timers.clear();
		};
	}, []);
}
