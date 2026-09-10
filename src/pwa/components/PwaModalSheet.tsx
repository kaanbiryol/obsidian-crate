import React, { useLayoutEffect } from 'react';
import {
	Sheet,
	type SheetDetent,
	type SheetTweenConfig,
} from 'react-modal-sheet';
import { lockSheetDocumentScroll } from '../sheet-scroll-lock';
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
	// Keep the page locked through the exit animation, until this sheet unmounts.
	useLayoutEffect(lockSheetDocumentScroll, []);
	const mountPoint = typeof document === 'undefined'
		? undefined
		: document.querySelector<HTMLElement>('.pwa-shadow-root') ?? undefined;
	const containerStyle = {
		// The library sets pointer-events inline. Keep the transparent area above
		// the reminder stage clickable through to the backdrop at the same level.
		pointerEvents: variant === 'reminder' ? 'none' : 'auto',
		...(keyboardInset > 0 ? { '--pwa-keyboard-inset': `${keyboardInset}px` } : {}),
	} as React.CSSProperties;

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
			// Our document lock leaves native editor touch events alone.
			disableScrollLocking
			avoidKeyboard={false}
			unstyled
			tweenConfig={isOpen ? OPEN_TWEEN : CLOSE_TWEEN}
			style={isOpen ? { visibility: 'visible' } : undefined}
			className={`pwa-modal-sheet pwa-modal-sheet--${variant}${sheetClassName ? ` ${sheetClassName}` : ''}${keyboardInset > 0 ? ' is-keyboard-open' : ''}`}
			onKeyDown={onKeyDown}
		>
			<div className="pwa-modal-sheet__scroll-boundary">
				<div className="pwa-modal-sheet__scroll-track">
					<div className="pwa-modal-sheet__viewport">
						<Sheet.Backdrop
							className="pwa-modal-sheet__backdrop"
							style={{ position: 'absolute' }}
							aria-label={closeOnBackdrop ? 'Close sheet' : undefined}
							onClick={closeOnBackdrop ? onClose : undefined}
						/>
						<Sheet.Container
							className={`pwa-modal-sheet__container pwa-modal-sheet__container--${variant}`}
							style={containerStyle}
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
					</div>
				</div>
			</div>
		</Sheet>
	);
}
