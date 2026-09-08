import React, { useCallback, useEffect, useRef } from 'react';
import {
	Sheet,
	type SheetDetent,
	type SheetTweenConfig,
} from 'react-modal-sheet';
import { shouldPreserveSheetFocus } from '../sheet-interaction';

const SHEET_INTERACTIVE_TARGET = [
	'button:not(:disabled)',
	'a[href]',
	'input:not(:disabled)',
	'textarea:not(:disabled)',
	'select:not(:disabled)',
	'label',
	'summary',
	'[contenteditable="true"]',
	'[role="button"]',
	'[role="link"]',
	'[role="option"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[role="textbox"]',
	'[role="combobox"]',
	'[tabindex]:not([tabindex="-1"])',
	'[data-sheet-interactive="true"]',
].join(',');

const OPEN_TWEEN: SheetTweenConfig = {
	ease: [0.32, 0.72, 0, 1],
	duration: 0.36,
};

const CLOSE_TWEEN: SheetTweenConfig = {
	ease: [0.4, 0, 1, 1],
	duration: 0.26,
};

export function PwaModalSheet({
	isOpen,
	onClose,
	onOpenStart,
	onOpenEnd,
	onCloseEnd,
	children,
	variant,
	sheetClassName,
	detent = 'default',
	keyboardInset = 0,
	closeOnBackdrop = true,
	onKeyDown,
}: {
	isOpen: boolean;
	onClose: () => void;
	onOpenStart?: () => void;
	onOpenEnd?: () => void;
	onCloseEnd: () => void;
	children: React.ReactNode;
	variant: 'reminder' | 'settings';
	sheetClassName?: string;
	detent?: SheetDetent;
	keyboardInset?: number;
	closeOnBackdrop?: boolean;
	onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const mountPoint = typeof document === 'undefined'
		? undefined
		: document.querySelector<HTMLElement>('.pwa-shadow-root') ?? undefined;
	const containerStyle = {
		// The library sets pointer-events inline. Keep the transparent area above
		// the reminder stage clickable through to the backdrop at the same level.
		pointerEvents: variant === 'reminder' ? 'none' : 'auto',
		...(keyboardInset > 0 ? { '--pwa-keyboard-inset': `${keyboardInset}px` } : {}),
	} as React.CSSProperties;
	const isInteractiveSheetTarget = useCallback((target: EventTarget | null) => (
		target instanceof Element && Boolean(target.closest(SHEET_INTERACTIVE_TARGET))
	), []);
	const preserveFocusOnBackgroundPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (!shouldPreserveSheetFocus({
			isInteractiveTarget: isInteractiveSheetTarget(event.target),
		})) return;
		event.preventDefault();
	}, [isInteractiveSheetTarget]);
	const preserveFocusOnBackgroundTouch = useCallback((event: TouchEvent) => {
		if (isInteractiveSheetTarget(event.target)) return;
		event.preventDefault();
	}, [isInteractiveSheetTarget]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !isOpen) return;

		container.addEventListener('touchstart', preserveFocusOnBackgroundTouch, {
			capture: true,
			passive: false,
		});
		return () => container.removeEventListener('touchstart', preserveFocusOnBackgroundTouch, true);
	}, [isOpen, preserveFocusOnBackgroundTouch]);

	return (
		<Sheet
			isOpen={isOpen}
			onClose={onClose}
			onOpenStart={onOpenStart}
			onOpenEnd={onOpenEnd}
			onCloseEnd={onCloseEnd}
			mountPoint={mountPoint}
			detent={detent}
			disableDrag
			disableDismiss
			avoidKeyboard={false}
			unstyled
			tweenConfig={isOpen ? OPEN_TWEEN : CLOSE_TWEEN}
			style={isOpen ? { visibility: 'visible' } : undefined}
			className={`pwa-modal-sheet pwa-modal-sheet--${variant}${sheetClassName ? ` ${sheetClassName}` : ''}${keyboardInset > 0 ? ' is-keyboard-open' : ''}`}
			onKeyDown={onKeyDown}
		>
			<Sheet.Backdrop
				className="pwa-modal-sheet__backdrop"
				aria-label={closeOnBackdrop ? 'Close sheet' : undefined}
				onPointerDown={(event) => event.preventDefault()}
				onClick={closeOnBackdrop ? onClose : undefined}
			/>
			<Sheet.Container
				ref={containerRef}
				className={`pwa-modal-sheet__container pwa-modal-sheet__container--${variant}`}
				style={containerStyle}
				onPointerDownCapture={preserveFocusOnBackgroundPointer}
			>
				<Sheet.Content
					disableDrag
					disableScroll
					className="pwa-modal-sheet__content"
					scrollClassName="pwa-modal-sheet__scroller"
				>
					{children}
				</Sheet.Content>
			</Sheet.Container>
		</Sheet>
	);
}
